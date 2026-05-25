#!/usr/bin/env bun
/**
 * spawn.ts — Launch a Pi agent from an agents/<name>.md definition
 *
 * Usage:
 *   bun scripts/spawn.ts planner
 *   bun scripts/spawn.ts builder ./my-project
 *   bun scripts/spawn.ts builder --model google/gemini-3-flash-preview
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const AGENTS_DIR = path.join(ROOT, "agents");

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
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
			fields[key] = val;
		}
	}
	fields._system_prompt = match[2].trim();
	return fields;
}

// ── Parse CLI ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const agentName = args[0];
if (!agentName) {
	console.error("Usage: bun scripts/spawn.ts <agent-name> [project-dir] [--model <model>] [--tools <tools>] [--project <dir>]");
	console.error("Agents:");
	for (const f of fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md"))) {
		const name = f.replace(/\.md$/, "");
		const parsed = parseAgentMd(path.join(AGENTS_DIR, f));
		const desc = parsed?.description || "";
		const model = parsed?.model || "";
		console.error(`  ${name.padEnd(15)} ${model.padEnd(30)} ${desc}`);
	}
	process.exit(1);
}

// ── Find agent file ───────────────────────────────────────────────

const agentFile = path.join(AGENTS_DIR, `${agentName}.md`);
if (!fs.existsSync(agentFile)) {
	console.error(`Agent "${agentName}" not found in ${AGENTS_DIR}/`);
	process.exit(1);
}

const fields = parseAgentMd(agentFile);
if (!fields) {
	console.error(`Failed to parse ${agentFile}`);
	process.exit(1);
}

// ── Override from CLI flags ──────────────────────────────────────

let model = fields.model || "openai/gpt-5.5";
let tools = fields.tools || "read,grep,find,ls";
const color = fields.color || "#36F9F6";
const name = fields.name || agentName;
const purpose = fields.description || "";
const systemPrompt = fields._system_prompt || "";
let projectDir = process.cwd();

let flagStart = 1;
if (args[1] && !args[1].startsWith("-")) {
	projectDir = path.resolve(args[1]);
	flagStart = 2;
}

for (let i = flagStart; i < args.length; i++) {
	if (args[i] === "--model" && i + 1 < args.length) { model = args[++i]; }
	else if (args[i] === "--tools" && i + 1 < args.length) { tools = args[++i]; }
	else if (args[i] === "--color" && i + 1 < args.length) { i++; } // ignored, use frontmatter
	else if (args[i] === "--project" && i + 1 < args.length) { projectDir = path.resolve(args[++i]); }
}

if (!fs.existsSync(projectDir)) {
	console.error(`Project directory does not exist: ${projectDir}`);
	process.exit(1);
}

// ── Write system prompt to temp file ────────────────────────────

const tmpFile = path.join(os.tmpdir(), `.peerstack-spawn-${Date.now()}.md`);
fs.writeFileSync(tmpFile, systemPrompt);

// ── Build pi command ────────────────────────────────────────────

// Hub tools are registered by the extension and MUST be in the --tools
// allowlist or they'll be filtered out by pi's tool gating.
const hubTools = "hub_list,hub_send,hub_get,hub_await,hub_status";
const allTools = tools + "," + hubTools;

const piArgs = [
	"-e", path.join(ROOT, "extensions", "agent.ts"),
	"-e", path.join(ROOT, "extensions", "minimal.ts"),
	"--model", model,
	"--tools", allTools,
	"--append-system-prompt", tmpFile,
];

// Pass identity flags to the extension
if (name) { piArgs.push("--name", name); }
if (color) { piArgs.push("--color", color); }

// Start message
console.log(`peerstack: spawning "${name}" → ${model} (tools: ${tools})`);
console.log(`  cwd: ${projectDir}`);
console.log(`  pi ${piArgs.join(" ")}`);
console.log("");

// ── Spawn pi ────────────────────────────────────────────────────

const child = spawn("pi", piArgs, {
	stdio: "inherit",
	env: { ...process.env },
	cwd: projectDir,
	detached: false,
});

child.on("exit", (code) => {
	// Clean up temp file
	try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
	process.exit(code ?? 0);
});

process.on("SIGINT", () => { child.kill("SIGINT"); });
process.on("SIGTERM", () => { child.kill("SIGTERM"); });
