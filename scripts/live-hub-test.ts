#!/usr/bin/env bun
/**
 * live-hub-test.ts — End-to-end test of peerstack hub with actual pi agents
 *
 * Usage: bun scripts/live-hub-test.ts
 *
 * This script:
 * 1. Starts the hub server on a test port
 * 2. Spawns 2 pi agents in tmux sessions
 * 3. Waits for them to register with the hub
 * 4. Sends a message from agent A to agent B via the hub API
 * 5. Waits for the response
 * 6. Reports all results
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

const TEST_PORT = 52977;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const ROOT = path.resolve(import.meta.dirname, "..");
const REG_ROOT = path.join(os.homedir(), ".pi", "peerstack");

let authToken = "";
let hubPid: number | null = null;

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function cleanup() {
  log("CLEANUP", "Shutting down...");
  if (hubPid) {
    try { process.kill(hubPid, "SIGTERM"); } catch {}
  }
  // Clean up tmux sessions
  try { spawnSync("tmux", ["kill-session", "-t", "peerstack-hub"]); } catch {}
  try { spawnSync("tmux", ["kill-session", "-t", "peerstack-scout"]); } catch {}
  try { spawnSync("tmux", ["kill-session", "-t", "peerstack-planner"]); } catch {}
}

function spawnSync(cmd: string, args: string[]) {
  return require("node:child_process").spawnSync(cmd, args, { stdio: "pipe" });
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function jsonApi(method: string, path: string, body?: unknown): Promise<any> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function waitForHub(maxAttempts = 50) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const sjPath = path.join(REG_ROOT, "server.json");
      if (fs.existsSync(sjPath)) {
        const sj = JSON.parse(fs.readFileSync(sjPath, "utf-8")) as { token: string; local_url: string };
        authToken = sj.token;
      }
      const resp = await fetch(`${BASE_URL}/health`, { headers: { "Authorization": `Bearer ${authToken}` } });
      if (resp.ok) return true;
    } catch { /* not ready */ }
    await sleep(200);
  }
  return false;
}

async function waitForAgents(count: number, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await jsonApi("GET", "/v1/agents");
      const agents = resp?.agents ?? [];
      if (agents.length >= count) return agents;
    } catch { /* ignore */ }
    await sleep(1000);
  }
  return [];
}

async function main() {
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Clean previous state
  const serverJsonPath = path.join(REG_ROOT, "server.json");
  try { fs.unlinkSync(serverJsonPath); } catch {}

  // Kill any leftover tmux sessions
  spawnSync("tmux", ["kill-session", "-t", "peerstack-hub"]);
  spawnSync("tmux", ["kill-session", "-t", "peerstack-scout"]);
  spawnSync("tmux", ["kill-session", "-t", "peerstack-planner"]);

  log("TEST", "═══════════════════════════════════════════");
  log("TEST", "Peerstack Hub Live Agent Test");
  log("TEST", "═══════════════════════════════════════════");

  // ── Step 1: Start hub in tmux session ──
  log("STEP1", "Starting hub server in tmux session...");
  const hubResult = spawnSync("tmux", ["new-session", "-d", "-s", "peerstack-hub", `bun hub/server.ts`]);
  log("STEP1", `tmux new-session exit: ${hubResult.status}`);
  await sleep(500);

  // Wait for hub to be ready
  log("STEP1", "Waiting for hub to be ready...");
  const hubReady = await waitForHub();
  if (!hubReady) {
    log("ERROR", "Hub failed to start");
    // Dump hub tmux output
    const hubLog = spawnSync("tmux", ["capture-pane", "-t", "peerstack-hub", "-p"]);
    console.log("Hub output:", hubLog.stdout?.toString());
    cleanup();
    process.exit(1);
  }
  log("STEP1", `Hub is running on ${BASE_URL}, token: ${authToken.slice(0, 16)}...`);

  // ── Step 2: Spawn scout agent ──
  log("STEP2", "Spawning scout agent...");
  const scoutCmd = [
    "pi",
    "-e", path.join(ROOT, "extensions", "agent.ts"),
    "-e", path.join(ROOT, "extensions", "minimal.ts"),
    "--model", "opencode-go/deepseek-v4-flash",
    "--tools", "read,grep,find,ls,hub_list,hub_send,hub_get,hub_await,hub_status",
    "--name", "scout",
    "--color", "#FEDE5D",
    "--append-system-prompt", "You are a scout agent. Investigate the codebase quickly and report findings concisely.",
  ];
  log("STEP2", `Command: ${scoutCmd.join(" ")}`);
  
  // Create temp file for system prompt
  const tmpDir = path.join(ROOT, ".pi");
  fs.mkdirSync(tmpDir, { recursive: true });
  const scoutPromptFile = path.join(tmpDir, "scout-prompt.md");
  fs.writeFileSync(scoutPromptFile, "You are a scout agent. Investigate the codebase quickly and report findings concisely.");
  
  const scoutCmdFixed = [
    "pi",
    "-e", path.join(ROOT, "extensions", "agent.ts"),
    "-e", path.join(ROOT, "extensions", "minimal.ts"),
    "--model", "opencode-go/deepseek-v4-flash",
    "--tools", "read,grep,find,ls,hub_list,hub_send,hub_get,hub_await,hub_status",
    "--name", "scout",
    "--color", "#FEDE5D",
    "--append-system-prompt", scoutPromptFile,
  ];
  
  const scoutTmuxResult = spawnSync("tmux", ["new-session", "-d", "-s", "peerstack-scout", scoutCmdFixed.join(" ")]);
  log("STEP2", `tmux new-session exit: ${scoutTmuxResult.status}`);

  // ── Step 3: Spawn planner agent ──
  log("STEP3", "Spawning planner agent...");
  const plannerPromptFile = path.join(tmpDir, "planner-prompt.md");
  fs.writeFileSync(plannerPromptFile, "You are a planner agent. Analyze requirements and produce clear, actionable implementation plans.");
  
  const plannerCmdFixed = [
    "pi",
    "-e", path.join(ROOT, "extensions", "agent.ts"),
    "-e", path.join(ROOT, "extensions", "minimal.ts"),
    "--model", "opencode-go/deepseek-v4-flash",
    "--tools", "read,grep,find,ls,hub_list,hub_send,hub_get,hub_await,hub_status",
    "--name", "planner",
    "--color", "#36F9F6",
    "--append-system-prompt", plannerPromptFile,
  ];
  
  const plannerTmuxResult = spawnSync("tmux", ["new-session", "-d", "-s", "peerstack-planner", plannerCmdFixed.join(" ")]);
  log("STEP3", `tmux new-session exit: ${plannerTmuxResult.status}`);

  // ── Step 4: Wait for agents to register ──
  log("STEP4", "Waiting for agents to register with hub...");
  const agents = await waitForAgents(2, 90);
  
  if (agents.length < 2) {
    log("WARN", `Only ${agents.length} agents registered after timeout`);
    log("WARN", "Dumping agent tmux outputs...");
    
    const scoutLog = spawnSync("tmux", ["capture-pane", "-t", "peerstack-scout", "-p"]);
    log("SCOUT-OUTPUT", scoutLog.stdout?.toString() || "(empty)");
    
    const plannerLog = spawnSync("tmux", ["capture-pane", "-t", "peerstack-planner", "-p"]);
    log("PLANNER-OUTPUT", plannerLog.stdout?.toString() || "(empty)");
  } else {
    log("STEP4", `Agents registered:`);
    for (const a of agents) {
      log("AGENT", `  ${a.name}#${a.session_id.slice(-6)} (${a.model}) status=${a.status}`);
    }
  }

  // ── Step 5: Check hub dashboard state ──
  log("STEP5", "Checking hub state...");
  const hubList = await jsonApi("GET", "/v1/agents");
  log("HUB-LIST", JSON.stringify(hubList, null, 2));

  // ── Step 6: Capture current tmux outputs ──
  log("CAPTURE", "Current tmux session outputs:");
  
  const hubPane = spawnSync("tmux", ["capture-pane", "-t", "peerstack-hub", "-p"]);
  log("HUB-PANE", hubPane.stdout?.toString() || "(empty)");
  
  const scoutPane = spawnSync("tmux", ["capture-pane", "-t", "peerstack-scout", "-p"]);
  log("SCOUT-PANE", scoutPane.stdout?.toString() || "(empty)");
  
  const plannerPane = spawnSync("tmux", ["capture-pane", "-t", "peerstack-planner", "-p"]);
  log("PLANNER-PANE", plannerPane.stdout?.toString() || "(empty)");

  // ── Step 7: Test direct message via API ──
  if (agents.length >= 2) {
    const scoutAgent = agents.find(a => a.name === "scout");
    const plannerAgent = agents.find(a => a.name === "planner");
    
    if (scoutAgent && plannerAgent) {
      log("STEP7", `Sending message from scout (${scoutAgent.session_id}) to planner (${plannerAgent.session_id})...`);
      
      const sendResult = await jsonApi("POST", "/v1/messages", {
        sender_session: scoutAgent.session_id,
        target: plannerAgent.session_id,
        prompt: "Hello from scout! What is 2+2? Please respond with just the answer.",
      });
      log("SEND-RESULT", JSON.stringify(sendResult, null, 2));
      
      // Wait a bit for the message to be processed
      await sleep(3000);
      
      // Check message status
      if (sendResult.msg_id) {
        const msgStatus = await jsonApi("GET", `/v1/messages/${sendResult.msg_id}`);
        log("MSG-STATUS", JSON.stringify(msgStatus, null, 2));
      }
    }
  }

  // ── Step 8: Final capture ──
  log("FINAL", "Final tmux session outputs:");
  await sleep(2000);
  
  const finalHubPane = spawnSync("tmux", ["capture-pane", "-t", "peerstack-hub", "-p"]);
  log("FINAL-HUB", finalHubPane.stdout?.toString() || "(empty)");
  
  const finalScoutPane = spawnSync("tmux", ["capture-pane", "-t", "peerstack-scout", "-p"]);
  log("FINAL-SCOUT", finalScoutPane.stdout?.toString() || "(empty)");
  
  const finalPlannerPane = spawnSync("tmux", ["capture-pane", "-t", "peerstack-planner", "-p"]);
  log("FINAL-PLANNER", finalPlannerPane.stdout?.toString() || "(empty)");

  // ── Cleanup ──
  log("DONE", "Test complete. Cleaning up...");
  cleanup();
}

main().catch(err => {
  console.error("Fatal error:", err);
  cleanup();
  process.exit(1);
});
