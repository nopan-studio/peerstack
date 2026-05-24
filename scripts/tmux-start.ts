#!/usr/bin/env bun
/**
 * tmux-start.ts — Launch hub + all agents from agents/*.md in a tmux session
 *
 * Usage:
 *   bun scripts/tmux-start.ts
 *   ./stak team
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const AGENTS_DIR = path.join(ROOT, "agents");
const REG_ROOT = path.join(process.env.HOME ?? "~", ".pi", "peerstack");
const SESSION_NAME = "peerstack-team";
const TMP_DIR = path.join(ROOT, ".pi");

// ── Ensure tmp dir exists ──────────────────────────────────────

fs.mkdirSync(TMP_DIR, { recursive: true });

// ── Frontmatter parser (same format as scripts/spawn.ts) ───────

function parseAgentMd(filePath: string): Record<string, string> | null {
	const raw = fs.readFileSync(filePath, "utf-8");
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return null;

	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			let key = line.slice(0, idx).trim();
			let val = line.slice(idx + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
				val = val.slice(1, -1);
			fields[key] = val;
		}
	}
	fields._system_prompt = match[2].trim();
	return fields;
}

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function tmux(args: string[]): void {
	const r = spawnSync("tmux", args, { stdio: "pipe" });
	if (r.status !== 0 && r.status !== null) {
		// tmux kill-session exits non-zero if session doesn't exist — that's ok
		const cmd = args.join(" ");
		if (!(args[0] === "kill-session" && r.status === 1)) {
			console.error(`tmux ${cmd} exited with status ${r.status}`);
		}
	}
}

// ── Hub readiness check ───────────────────────────────────────

async function waitForHub(maxWaitMs = 30000): Promise<{ local_url: string; token: string }> {
	const deadline = Date.now() + maxWaitMs;
	const serverJsonPath = path.join(REG_ROOT, "server.json");

	while (Date.now() < deadline) {
		try {
			const sj = JSON.parse(fs.readFileSync(serverJsonPath, "utf-8"));
			const resp = await fetch(sj.local_url + "/health", {
				headers: { Authorization: `Bearer ${sj.token}` },
			});
			if (resp.ok) return sj;
		} catch {
			// Hub not ready yet
		}
		await sleep(200);
	}
	throw new Error("hub did not become ready within " + maxWaitMs + "ms");
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
	// 1. Silently kill existing session (non-zero exit if it doesn't exist is fine)
	tmux(["kill-session", "-t", SESSION_NAME]);

	// 2. Start hub in window 0
	console.log(`peerstack: starting hub in tmux session "${SESSION_NAME}"...`);
	tmux([
		"new-session", "-d",
		"-s", SESSION_NAME,
		"-n", "hub",
		"bun hub/server.ts",
	]);

	// 3. Wait for hub to be ready
	console.log("peerstack: waiting for hub...");
	let hubInfo: { local_url: string; token: string };
	try {
		hubInfo = await waitForHub();
		console.log(`peerstack: hub ready at ${hubInfo.local_url}`);
	} catch (e: any) {
		console.error(e.message);
		process.exit(1);
	}

	// 4. Discover agent files
	const agentFiles = fs
		.readdirSync(AGENTS_DIR)
		.filter(f => f.endsWith(".md"))
		.sort();

	if (agentFiles.length === 0) {
		console.error("No agent definitions found in agents/");
		process.exit(1);
	}

	// 5. Spawn agents
	const hubTools = "hub_list,hub_send,hub_get,hub_await,hub_status";

	for (let i = 0; i < agentFiles.length; i++) {
		const file = agentFiles[i];
		const filePath = path.join(AGENTS_DIR, file);
		const fields = parseAgentMd(filePath);

		if (!fields) {
			console.error(`Skipping ${file}: failed to parse frontmatter`);
			continue;
		}

		const agentName = fields.name || file.replace(/\.md$/, "");
		const model = fields.model || "openai/gpt-5.5";
		const tools = fields.tools || "read,grep,find,ls";
		const color = fields.color || "#36F9F6";
		const systemPrompt = fields._system_prompt || "";

		// Write system prompt to temp file
		const tmpFile = path.join(TMP_DIR, `.spawn-tmp-${agentName}.md`);
		fs.writeFileSync(tmpFile, systemPrompt);

		// Build pi command
		const allTools = tools + "," + hubTools;
		const piArgs = [
			"-e", path.join(ROOT, "extensions", "agent.ts"),
			"-e", path.join(ROOT, "extensions", "minimal.ts"),
			"--model", model,
			"--tools", allTools,
			"--name", agentName,
			"--color", color,
			"--append-system-prompt", tmpFile,
		];

		const cmdStr = `pi ${piArgs.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`;

		console.log(`peerstack: spawning "${agentName}" → ${model} (tools: ${tools})`);

		// Create new tmux window
		tmux([
			"new-window",
			"-t", SESSION_NAME,
			"-n", agentName,
			cmdStr,
		]);

		// Small delay between spawns
		if (i < agentFiles.length - 1) {
			await sleep(500);
		}
	}

	// 6. Done
	console.log("");
	console.log(`tmux session ready. Attach with: tmux attach -t ${SESSION_NAME}`);

	// 7. Cleanup on signal
	const cleanup = () => {
		console.log("\npeerstack: shutting down tmux session...");
		tmux(["kill-session", "-t", SESSION_NAME]);
		process.exit(0);
	};

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
