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
import { spawnSync, execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const AGENTS_DIR = path.join(ROOT, "agents");
const REG_ROOT = path.join(process.env.HOME ?? "~", ".pi", "peerstack");
const BASE_SESSION_NAME = "peerstack-team";
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
		const cmd = args.join(" ");
		if (args[0] === "kill-session" && r.status === 1) return;
		console.error(`tmux ${cmd} exited with status ${r.status}`);
	}
}

function isTmuxServerRunning(): boolean {
	const r = spawnSync("tmux", ["info"], { stdio: "pipe" });
	return r.status === 0;
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
	const serverRunning = isTmuxServerRunning();
	const inTmux = !!process.env.TMUX;
	const SESSION_NAME = BASE_SESSION_NAME;

	// Kill existing session for clean restart
	spawnSync("tmux", ["kill-session", "-t", BASE_SESSION_NAME], { stdio: "pipe" });

	// 1. Start hub in window 0
	console.log(`peerstack: starting hub in tmux session "${SESSION_NAME}"...`);
	tmux([
		"new-session", "-d",
		"-s", SESSION_NAME,
		"-n", "hub",
		"bun", "hub/server.ts",
	]);

	// Cleanup partial session if interrupted mid-flight
	const cleanup = () => {
		console.log("\npeerstack: interrupted — killing session...");
		tmux(["kill-session", "-t", SESSION_NAME]);
		process.exit(1);
	};
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	// 2. Wait for hub to be ready
	console.log("peerstack: waiting for hub...");
	let hubInfo: { local_url: string; token: string };
	try {
		hubInfo = await waitForHub();
		console.log(`peerstack: hub ready at ${hubInfo.local_url}`);
	} catch (e: any) {
		console.error(e.message);
		tmux(["kill-session", "-t", SESSION_NAME]);
		process.exit(1);
	}

	// 3. Discover agent files
	const agentFiles = fs
		.readdirSync(AGENTS_DIR)
		.filter(f => f.endsWith(".md"))
		.sort();

	if (agentFiles.length === 0) {
		console.error("No agent definitions found in agents/");
		tmux(["kill-session", "-t", SESSION_NAME]);
		process.exit(1);
	}

	// 4. Build agent commands
	const hubTools = "hub_list,hub_send,hub_get,hub_await,hub_status";
	const agents: { name: string; cmd: string }[] = [];

	for (const file of agentFiles) {
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

		const tmpFile = path.join(TMP_DIR, `.spawn-tmp-${agentName}.md`);
		fs.writeFileSync(tmpFile, systemPrompt);

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
		agents.push({ name: agentName, cmd: cmdStr });
	}

	if (agents.length === 0) {
		console.error("No valid agents found.");
		tmux(["kill-session", "-t", SESSION_NAME]);
		process.exit(1);
	}

	// 5. Create a new window for each agent
	console.log(`peerstack: spawning ${agents.length} agent(s) in separate windows...`);

	for (const agent of agents) {
		console.log(`peerstack: spawning "${agent.name}"`);
		tmux([
			"new-window",
			"-t", SESSION_NAME,
			"-n", agent.name,
			agent.cmd,
		]);
		await sleep(500);
	}

	// 6. Auto-attach or print instructions
	console.log("");
	if (!serverRunning && !inTmux) {
		console.log(`peerstack: tmux was not running — attaching to ${SESSION_NAME}...`);
		execFileSync("tmux", ["attach", "-t", SESSION_NAME], { stdio: "inherit" });
	} else if (inTmux) {
		console.log(`peerstack: created new session "${SESSION_NAME}".`);
		console.log(`          Switch with: tmux switch-client -t ${SESSION_NAME}`);
	} else {
		console.log(`peerstack: created new session "${SESSION_NAME}".`);
		console.log(`          Attach with: tmux attach -t ${SESSION_NAME}`);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
