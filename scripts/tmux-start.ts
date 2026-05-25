#!/usr/bin/env bun
/**
 * tmux-start.ts — Launch all agents from agents/*.md in the CURRENT tmux window panes
 *
 * Assumes hub is already running (start it manually with: ./stak hub)
 *
 * Usage:
 *   bun scripts/tmux-start.ts
 *   bun scripts/tmux-start.ts ./my-project
 *   ./stak team
 *   ./stak team ./my-project
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const AGENTS_DIR = path.join(ROOT, "agents");
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "peerstack");
const TMP_DIR = path.join(os.tmpdir(), "peerstack");

fs.mkdirSync(TMP_DIR, { recursive: true });

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

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function shellEscape(arg: string): string {
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

function tmux(args: string[]): void {
	const r = spawnSync("tmux", args, { stdio: "pipe" });
	if (r.status !== 0 && r.status !== null) {
		const cmd = args.join(" ");
		console.error(`tmux ${cmd} exited with status ${r.status}`);
		if (r.stderr) console.error(r.stderr.toString());
	}
}

async function hubIsUp(): Promise<boolean> {
	try {
		const serverJsonPath = path.join(CONFIG_DIR, "server.json");
		const sj = JSON.parse(fs.readFileSync(serverJsonPath, "utf-8"));
		const resp = await fetch(sj.local_url + "/health", {
			headers: { Authorization: `Bearer ${sj.token}` },
		});
		return resp.ok;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const inTmux = !!process.env.TMUX;

	if (!inTmux) {
		console.error("peerstack: error — not inside a tmux session.");
		console.error("  Start tmux first, then run: ./stak team");
		process.exit(1);
	}

	const hubRunning = await hubIsUp();
	if (!hubRunning) {
		console.log("peerstack: warning — hub not detected. Start it first: ./stak hub");
	}

	// Parse optional project dir
	const args = process.argv.slice(2);
	let projectDir = process.cwd();
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--project" && i + 1 < args.length) {
			projectDir = path.resolve(args[++i]);
		} else if (i === 0 && !args[i].startsWith("-")) {
			projectDir = path.resolve(args[i]);
		}
	}
	if (!fs.existsSync(projectDir)) {
		console.error(`Project directory does not exist: ${projectDir}`);
		process.exit(1);
	}

	const agentFiles = fs
		.readdirSync(AGENTS_DIR)
		.filter(f => f.endsWith(".md"))
		.sort();

	if (agentFiles.length === 0) {
		console.error("No agent definitions found in agents/");
		process.exit(1);
	}

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

		const safeAgentName = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
		const tmpFile = path.join(TMP_DIR, `.spawn-tmp-${safeAgentName}.md`);
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

		const cmdStr = `pi ${piArgs.map(shellEscape).join(" ")}`;
		agents.push({ name: agentName, cmd: cmdStr });
	}

	if (agents.length === 0) {
		console.error("No valid agents found.");
		process.exit(1);
	}

	console.log(`peerstack: spawning ${agents.length} agent(s) in panes...`);
	console.log(`peerstack: project dir → ${projectDir}`);

	for (const agent of agents) {
		console.log(`peerstack: spawning "${agent.name}"`);
		console.log(`  cmd: ${agent.cmd}`);
		tmux(["split-window", "-d", "-c", projectDir, agent.cmd]);
		await sleep(500);
	}

	for (const agent of agents) {
		const safeAgentName = agent.name.replace(/[^a-zA-Z0-9_-]/g, "_");
		const tmpFile = path.join(TMP_DIR, `.spawn-tmp-${safeAgentName}.md`);
		try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
	}

	console.log("peerstack: tiling panes...");
	tmux(["select-layout", "tiled"]);

	console.log("");
	console.log("peerstack: team is live in the current tmux window.");
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
