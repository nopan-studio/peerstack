/**
 * peerstack agent extension — Hub client for Pi agents
 *
 * Each agent connects to the peerstack hub, registers with its name/model/color,
 * and provides 5 tools for agent-to-agent messaging. Inbound prompts arrive
 * as follow-up messages; replies auto-flow back via agent_end.
 *
 * A live pool widget below the editor shows all connected agents (name, model,
 * context %, status) and refreshes on SSE events + every 5 seconds.
 *
 * Usage:
 *   pi -e extensions/agent.ts --model openai/gpt-5.5 --name planner --color "#36F9F6"
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { applyExtensionDefaults } from "./themeMap.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const REG_ROOT = path.join(os.homedir(), ".pi", "peerstack");
const ENV_SERVER_URL = process.env.PEERSTACK_SERVER_URL;
const ENV_AUTH_TOKEN = process.env.PEERSTACK_AUTH_TOKEN;
const MAX_HOPS = Number(process.env.PEERSTACK_MAX_HOPS) || 5;
const HEARTBEAT_MS = Number(process.env.PEERSTACK_HEARTBEAT_MS) || 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const HTTP_TIMEOUT_MS = 10_000;
const SHUTDOWN_DELETE_TIMEOUT_MS = 2_000;
const MESSAGE_TIMEOUT_MS = 1_800_000;

// ━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface AgentCard {
	session_id: string; name: string; model: string;
	color: string; status: string;
	context_used_pct: number; queue_depth: number;
}

interface InboundContext {
	msg_id: string; hops: number; sender_session: string;
	sender_name: string; sender_cwd: string; prompt_text: string; fulfilled: boolean;
}

interface PendingReply {
	resolve: (v: { response?: any; error?: string | null }) => void;
	promise: Promise<{ response?: any; error?: string | null }>;
	result?: { response?: any; error?: string | null };
}

// ━━ Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
	const time = Date.now(); const rand = crypto.randomBytes(10);
	let timeStr = ""; let t = time;
	for (let i = 9; i >= 0; i--) { timeStr = CROCKFORD[t % 32] + timeStr; t = Math.floor(t / 32); }
	let randStr = ""; let bits = 0; let value = 0;
	for (const byte of rand) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; randStr += CROCKFORD[(value >> bits) & 31]; } }
	return (timeStr + randStr).slice(0, 26);
}

function abbreviateModel(model: string): string {
	let m = model || "";
	if (m.includes("/")) m = m.split("/").pop() || m;
	if (m.startsWith("claude-")) m = m.slice("claude-".length);
	return m;
}

function shortId(s: string): string {
	return s.length > 6 ? s.slice(-6) : s;
}

function hexFg(hex: string, s: string): string {
	const r = parseInt(hex.slice(1, 3), 16); const g = parseInt(hex.slice(3, 5), 16); const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

function nowIso(): string { return new Date().toISOString(); }

// ━━ Server discovery ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface ServerJson { local_url: string; token?: string; }

function readServerJson(): ServerJson | null {
	const p = path.join(REG_ROOT, "server.json");
	try { if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, "utf-8")) as ServerJson; } catch { return null; }
}

function resolveServerUrl(): string {
	if (ENV_SERVER_URL) return ENV_SERVER_URL.replace(/\/+$/, "");
	const sj = readServerJson();
	if (sj?.local_url) return sj.local_url.replace(/\/+$/, "");
	throw new Error("no peerstack server URL. Start the hub first: stak hub");
}

function resolveAuthToken(): string {
	if (ENV_AUTH_TOKEN) return ENV_AUTH_TOKEN;
	const sj = readServerJson();
	if (sj?.token) return sj.token;
	throw new Error("no auth token. Set PEERSTACK_AUTH_TOKEN or start hub first");
}

// ━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
	pi.registerFlag("name", { description: "Agent name", type: "string", default: undefined });
	pi.registerFlag("color", { description: "Hex color #RRGGBB", type: "string", default: undefined });

	let identity: { session_id: string; name: string; color: string; cwd: string; model: string } | null = null;
	let serverUrl: string | null = null;
	let authToken: string | null = null;
	const inboundQueue: Map<string, InboundContext> = new Map();
	const pendingReplies: Map<string, PendingReply> = new Map();
	let currentCtx: ExtensionContext | null = null;
	let currentInbound: InboundContext | null = null;
	let sseAbort: AbortController | null = null;
	let heartbeatTimer: NodeJS.Timeout | null = null;
	let reconnectTimer: NodeJS.Timeout | null = null;
	let reconnectAttempts = 0;
	let shuttingDown = false;
	let connected = false;

	// Inbound message queue — processes incoming prompts and triggers agent turns
	const inboundMessageQueue: (() => Promise<void>)[] = [];

	async function processInboundQueue(): Promise<void> {
		if (inboundMessageQueue.length === 0) return;
		const task = inboundMessageQueue.shift();
		if (task) await task();
		if (inboundMessageQueue.length > 0) await processInboundQueue();
	}

	// Pool state — shared across SSE events and refresh timer
	let poolAgents: AgentCard[] = [];
	let poolTimer: NodeJS.Timeout | null = null;

	// ━━ HTTP helper ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	class HttpError extends Error { constructor(public status: number, public body: any, message?: string) { super(message ?? `HTTP ${status}`); } }

	async function api(method: string, urlPath: string, body?: any, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<any> {
		const url = serverUrl! + urlPath;
		const headers: Record<string, string> = { "Authorization": `Bearer ${authToken}`, "Accept": "application/json" };
		const init: any = { method, headers };
		if (body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
		const ac = new AbortController(); const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, opts?.timeoutMs ?? HTTP_TIMEOUT_MS);
		try { (timer as any).unref?.(); } catch { /* ignore */ }
		init.signal = opts?.signal ?? ac.signal;
		try { const resp = await fetch(url, init); const text = await resp.text(); let parsed: any = null; if (text.length > 0) try { parsed = JSON.parse(text); } catch { parsed = text; } if (!resp.ok) throw new HttpError(resp.status, parsed); return parsed; }
		finally { clearTimeout(timer); }
	}

	function safeError(err: any): string {
		const msg = err instanceof Error ? err.message : String(err);
		return authToken ? msg.split(authToken).join("<redacted>") : msg;
	}

	// ━━ SSE parser ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	function sseParser(onEvent: (event: string, data: any) => void) {
		const dec = new TextDecoder("utf-8"); let buf = "";
		let chunkCount = 0;
		return {
			feed(chunk: Uint8Array) {
				chunkCount++;
				const decoded = dec.decode(chunk, { stream: true });
				console.error(`[peerstack:${identity?.name}] SSE received chunk #${chunkCount}, ${chunk.length} bytes`);
				buf += decoded;
				let idx; while ((idx = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
					let event = "message"; const lines: string[] = [];
					for (const line of frame.split("\n")) {
						if (line.startsWith(":")) continue;
						if (line.startsWith("event:")) event = line.slice(6).trimStart();
						else if (line.startsWith("data:")) { let v = line.slice(5); if (v.startsWith(" ")) v = v.slice(1); lines.push(v); }
					}
					if (lines.length > 0) { const d = lines.join("\n"); let data: any = d; try { data = JSON.parse(d); } catch { /* string */ } console.error(`[peerstack:${identity?.name}] Parsed SSE: event=${event}, data=`, JSON.stringify(data).slice(0, 100)); try { onEvent(event, data); } catch (e) { console.error(`[peerstack:${identity?.name}] onEvent error:`, e); } }
				}
			},
		};
	}

	// ━━ Pool widget — live agent list below editor ━━━━━━━━━━━━━━━━━━━━━━━

	let lastFetchError = "";

	async function fetchAllAgents(): Promise<AgentCard[]> {
		if (!serverUrl || !authToken) { lastFetchError = "not connected to hub"; return []; }
		try {
			const resp = await api("GET", "/v1/agents");
			lastFetchError = "";
			return Array.isArray(resp?.agents) ? resp.agents : [];
		} catch (err: any) {
			lastFetchError = err instanceof HttpError ? `HTTP ${err.status}` : err?.message || String(err);
			return [];
		}
	}

	function isSelf(a: AgentCard): boolean {
		return identity !== null && a.session_id === identity.session_id;
	}

	async function refreshPoolDisplay(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const agents = await fetchAllAgents();
		// Check if anything actually changed
		const key = agents.map(a => `${a.session_id}|${a.name}|${a.model}|${a.status}|${a.context_used_pct}|${a.queue_depth}`).sort().join(",");
		const prevKey = poolAgents.map(a => `${a.session_id}|${a.name}|${a.model}|${a.status}|${a.context_used_pct}|${a.queue_depth}`).sort().join(",");
		if (key === prevKey) return;
		poolAgents = agents;
		renderPoolWidget(ctx);
	}

	function renderPoolWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("peerstack-pool", (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				if (poolAgents.length === 0) return [];
				const out: string[] = [];
				const sorted = [...poolAgents].sort((a, b) => a.name.localeCompare(b.name));
				for (const a of sorted) {
					const dot = a.status === "online"
						? hexFg(a.color, "●")
						: a.status === "stale" ? theme.fg("warning", "~") : theme.fg("error", "✗");
					const filled = Math.max(0, Math.min(8, Math.round((a.context_used_pct / 100) * 8)));
					const bar = theme.fg("success", "#".repeat(filled)) + theme.fg("dim", "-".repeat(8 - filled));
					const pct = theme.fg("accent", `${String(Math.round(a.context_used_pct)).padStart(3)}%`);
					const busy = a.queue_depth > 0 && a.status === "online" ? theme.fg("warning", " ⚡") : "";
					const selfTag = isSelf(a) ? theme.fg("warning", " (you)") : "";
					const line = ` ${dot} ${theme.fg("accent", a.name)}${theme.fg("dim", "#" + shortId(a.session_id))}${selfTag} ${theme.fg("dim", abbreviateModel(a.model).padEnd(12))} [${bar}] ${pct}${busy}`;
					out.push(truncateToWidth(line, width));
				}
				return out;
			},
		}), { placement: "belowEditor" });
	}

	function startPoolRefresh(ctx: ExtensionContext): void {
		void refreshPoolDisplay(ctx);
		if (poolTimer) clearInterval(poolTimer);
		poolTimer = setInterval(() => {
			void refreshPoolDisplay(ctx);
		}, 5000);
		try { (poolTimer as any).unref?.(); } catch { /* ignore */ }
	}

	// ━━ SSE lifecycle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function openSse(): Promise<void> {
		if (!identity || !serverUrl || !authToken) return;
		if (sseAbort) try { sseAbort.abort(); } catch { /* ignore */ }
		const ac = new AbortController(); sseAbort = ac;
		const url = serverUrl + `/v1/events?session_id=${encodeURIComponent(identity.session_id)}`;
		console.error(`[peerstack:${identity?.name}] Opening SSE connection to ${url}`);
		let resp: Response;
		try { resp = await fetch(url, { method: "GET", headers: { "Authorization": `Bearer ${authToken}`, "Accept": "text/event-stream" }, signal: ac.signal }); } catch (e) {
			console.error(`[peerstack:${identity?.name}] SSE fetch failed:`, e);
			if (connected) {
				connected = false;
				if (currentCtx?.hasUI) try { currentCtx.ui.notify(" peerstack: disconnected — reconnecting...", "warning"); } catch { /* ignore */ }
			}
			scheduleReconnect(); return;
		}
		if (!resp.ok || !resp.body) {
			console.error(`[peerstack:${identity?.name}] SSE response not ok: ${resp.status}`);
			if (connected) {
				connected = false;
				if (currentCtx?.hasUI) try { currentCtx.ui.notify("📡 peerstack: disconnected — reconnecting...", "warning"); } catch { /* ignore */ }
			}
			scheduleReconnect(); return;
		}
		console.error(`[peerstack:${identity?.name}] SSE connection established, status=${resp.status}`);
		if (!connected) {
			connected = true;
			if (currentCtx?.hasUI) try { currentCtx.ui.notify("📡 peerstack: connected", "success"); } catch { /* ignore */ }
		}
		reconnectAttempts = 0;
		const parser = sseParser((event, data) => {
			console.error(`[peerstack:${identity?.name}] SSE event:`, event, data?.msg_id ? `msg_id=${data.msg_id}` : '');
			switch (event) {
				case "prompt": {
					console.error(`[peerstack:${identity?.name}] Received prompt from ${data?.sender?.name || 'unknown'}`);
					const msg_id = data?.msg_id; if (!msg_id) return;
					const sender = data.sender ?? {};
					const senderName = sender.name || "unknown";
					const promptText = data.prompt || "";
					const inbound: InboundContext = {
						msg_id, hops: typeof data.hops === "number" ? data.hops : 0,
						sender_session: sender.session_id || "?", sender_name: senderName,
						sender_cwd: sender.cwd || "?", prompt_text: promptText, fulfilled: false,
					};
					inboundQueue.set(msg_id, inbound);
					currentInbound = inbound;
					console.error(`[peerstack:${identity?.name}] Queued inbound, scheduling turn trigger`);
					// Defer turn trigger to avoid blocking SSE reader
					setImmediate(() => {
						console.error(`[peerstack:${identity?.name}] Triggering turn for inbound message`);
						void (async () => {
							try {
								await pi.sendUserMessage(`>>> 📨 MESSAGE FROM ${senderName.toUpperCase()} <<<\n\n${promptText}\n\n(Your response will be automatically sent back to ${senderName}.)`);
							} catch (e) {
								console.error(`[peerstack:${identity?.name}] sendUserMessage failed:`, e);
							}
						})();
					});
					break;
				}
				case "response": {
					const msg_id = data?.msg_id; if (!msg_id) return;
					const p = pendingReplies.get(msg_id);
					if (p) { p.result = { response: data.response, error: data.error ?? null }; try { p.resolve(p.result); } catch { /* ignore */ } }
					break;
				}
				case "pool_snapshot":
				case "agent_joined":
				case "agent_updated":
				case "agent_left":
				case "agent_stale":
					if (currentCtx?.hasUI) { void refreshPoolDisplay(currentCtx); }
					break;
			}
		});
		const reader = resp.body.getReader();
		try {
			console.error(`[peerstack:${identity?.name}] Starting SSE reader loop`);
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					console.error(`[peerstack:${identity?.name}] SSE stream ended`);
					break;
				}
				if (value) {
					console.error(`[peerstack:${identity?.name}] Reader got ${value.length} bytes`);
					parser.feed(value);
				}
			}
		} catch (e) {
			console.error(`[peerstack:${identity?.name}] SSE reader error:`, e);
		}
		finally { try { reader.releaseLock(); } catch { /* ignore */ } }
		// Connection dropped
		if (connected) {
			connected = false;
			if (currentCtx?.hasUI) try { currentCtx.ui.notify("📡 peerstack: disconnected — reconnecting...", "warning"); } catch { /* ignore */ }
		}
		if (!shuttingDown) scheduleReconnect();
	}

	function scheduleReconnect(): void {
		if (shuttingDown || reconnectTimer) return;
		const backoff = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
		reconnectAttempts++;
		reconnectTimer = setTimeout(async () => {
			reconnectTimer = null; if (shuttingDown) return;
			try { await registerAndOpen(); } catch {
				connected = false;
				scheduleReconnect();
			}
		}, backoff);
		try { (reconnectTimer as any).unref?.(); } catch { /* ignore */ }
	}

	async function registerAndOpen(): Promise<void> {
		if (!identity) return;
		const ctx = currentCtx;
		await api("POST", "/v1/agents/register", {
			session_id: identity.session_id, name: identity.name,
			model: ctx?.model?.id ?? identity.model, color: identity.color, cwd: identity.cwd,
		});
		void openSse();
	}

	// ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		currentCtx = ctx;

		const name = (pi.getFlag("name") as string) || `agent-${ulid().slice(-6)}`;
		const color = (pi.getFlag("color") as string) || "#36F9F6";
		identity = { session_id: ulid(), name, color, cwd: ctx.cwd || process.cwd(), model: ctx.model?.id ?? "unknown" };

		try { serverUrl = resolveServerUrl(); authToken = resolveAuthToken(); } catch (err: any) {
			ctx.ui?.notify?.(`peerstack: ${err.message}`, "error"); return;
		}
		try { await api("GET", "/health"); } catch (err) {
			ctx.ui?.notify?.(`peerstack: hub unreachable at ${serverUrl} — ${safeError(err)}`, "error"); return;
		}
		try {
			await registerAndOpen();
			connected = true;
			ctx.ui.setStatus("peerstack", `📡 ${name} (connected)`);
			ctx.ui.notify(`peerstack: connected as ${name} @ ${serverUrl}`, "info");
			startPoolRefresh(ctx);
		} catch (err) { ctx.ui?.notify?.(`peerstack: register failed — ${safeError(err)}`, "error"); return; }

		heartbeatTimer = setInterval(() => {
			if (!identity || shuttingDown) return;
			const ctxNow = currentCtx;
			api("POST", `/v1/agents/${encodeURIComponent(identity.session_id)}/heartbeat`, {
				context_used_pct: Math.round(ctxNow?.getContextUsage()?.percent ?? 0),
				queue_depth: inboundQueue.size, model: ctxNow?.model?.id ?? identity.model,
			}, { timeoutMs: 5_000 }).catch(() => {});
		}, HEARTBEAT_MS);
		try { (heartbeatTimer as any).unref?.(); } catch { /* ignore */ }
	});

	// ━━ agent_end: auto-reply to inbound prompts ━━━━━━━━━━━━━━━━━━━━━━━━
	pi.on("agent_end", async (_event, ctx) => {
		const inbound = [...inboundQueue.values()].reverse().find(i => !i.fulfilled);
		if (!inbound || !identity) return;
		
		// Capture the assistant's response text
		let text = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as any;
				if (typeof m.content === "string") text = m.content;
				else if (Array.isArray(m.content)) text = m.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
			}
		}
		
		// Only send response if we captured actual text
		if (text.trim()) {
			try {
				await api("POST", `/v1/messages/${encodeURIComponent(inbound.msg_id)}/response`, {
					responder_session: identity.session_id,
					response: text,
				});
				inbound.fulfilled = true;
				inboundQueue.delete(inbound.msg_id);
				if (currentInbound?.msg_id === inbound.msg_id) currentInbound = null;
			} catch {
				// POST failed — keep inbound pending for retry on next turn
			}
		} else {
			// No text captured — LLM may not have responded yet, keep pending
		}
	});

	// ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.registerTool({
		name: "hub_list", label: "Hub List",
		description: "List all connected agents on the peerstack hub.",
		parameters: Type.Object({}),
		async execute() {
			const agents = await fetchAllAgents();
			return {
				content: [{ type: "text" as const, text: agents.length === 0 ? "No agents on hub." : `Agents on hub (${agents.length}):\n${agents.map(a => `${a.status === "online" ? "●" : a.status === "stale" ? "~" : "✗"} ${a.name}#${shortId(a.session_id)}${isSelf(a) ? " (you)" : ""} (${abbreviateModel(a.model)}) ${Math.round(a.context_used_pct)}%`).join("\n")}` }],
				details: { agents },
			};
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("hub_list")), 0, 0); },
		renderResult(result, options, theme) {
			const d = result.details as any; const agents: any[] = d?.agents ?? [];
			const h = theme.fg("accent", `📡 ${agents.length} peer(s)`);
			if (!options.expanded || agents.length === 0) return new Text(h, 0, 0);
			return new Text(h + "\n" + agents.map((a: any) => `${a.status === "online" ? theme.fg("success", "●") : a.status === "stale" ? theme.fg("warning", "~") : theme.fg("error", "✗")} ${theme.fg("accent", a.name)}${theme.fg("dim", "#" + shortId(a.session_id))} ${theme.fg("dim", abbreviateModel(a.model))} ${theme.fg("warning", `${Math.round(a.context_used_pct)}%`)}`).join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "hub_send", label: "Hub Send",
		description: "Send a prompt to a peer agent. Returns a msg_id. Use hub_await (blocking) or hub_get (poll) to retrieve the reply.",
		parameters: Type.Object({ target: Type.String({ description: "Peer agent name." }), prompt: Type.String({ description: "The prompt to send." }) }),
		async execute(_callId, params) {
			if (!identity) throw new Error("not connected to peerstack hub");
			const hops = currentInbound ? currentInbound.hops + 1 : 0;
			if (hops >= MAX_HOPS) throw new Error(`hop limit reached (${hops}/${MAX_HOPS})`);
			// Strip #xxxx suffix if LLM picked it up from display tags
			const cleanTarget = params.target.replace(/#[A-Za-z0-9]+$/, "");
			const resp = await api("POST", "/v1/messages", { sender_session: identity.session_id, target: cleanTarget, prompt: params.prompt, hops });
			const msg_id = resp?.msg_id;
			let resolveFn!: (v: { response?: any; error?: string | null }) => void;
			const promise = new Promise<{ response?: any; error?: string | null }>(r => { resolveFn = r; });
			pendingReplies.set(msg_id, { resolve: resolveFn, promise });
			return { content: [{ type: "text" as const, text: `hub_send → ${params.target}\nmsg_id ${msg_id}\nhops ${hops}` }], details: { msg_id, target: params.target, hops } };
		},
		renderCall(args, theme) { const t = (args as any).target ?? "?"; const p = (args as any).prompt ?? ""; const prev = p.length > 60 ? p.slice(0, 57) + "..." : p; return new Text(theme.fg("toolTitle", theme.bold("hub_send ")) + theme.fg("accent", t) + theme.fg("dim", " — ") + theme.fg("muted", prev), 0, 0); },
		renderResult(result, _options, theme) { const d = result.details as any; return new Text(theme.fg("success", "→ ") + theme.fg("accent", d?.target) + theme.fg("dim", `  msg_id `) + theme.fg("warning", d?.msg_id), 0, 0); },
	});

	pi.registerTool({
		name: "hub_get", label: "Hub Get",
		description: "Non-blocking poll for a reply to hub_send. Returns status pending|complete|error.",
		parameters: Type.Object({ msg_id: Type.String({ description: "msg_id from hub_send." }) }),
		async execute(_callId, params) {
			const pending = pendingReplies.get(params.msg_id);
			if (pending?.result) { const r = pending.result; return { content: [{ type: "text" as const, text: r.error ? `error: ${r.error}` : typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2) }], details: { status: "complete", response: r.response, error: r.error } }; }
			try { const resp = await api("GET", `/v1/messages/${encodeURIComponent(params.msg_id)}`); const s = resp?.status ?? "pending"; if (s === "complete" || s === "error") return { content: [{ type: "text" as const, text: resp.error ? `error: ${resp.error}` : typeof resp.response === "string" ? resp.response : JSON.stringify(resp.response, null, 2) }], details: { status: s, response: resp.response, error: resp.error } }; return { content: [{ type: "text" as const, text: "pending" }], details: { status: "pending" } }; }
			catch { return { content: [{ type: "text" as const, text: "pending" }], details: { status: "pending" } }; }
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("hub_get ")) + theme.fg("warning", (args as any).msg_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { const d = result.details as any; const s = d?.status ?? "?"; return new Text(theme.fg(s === "complete" ? "success" : s === "pending" ? "warning" : "error", s), 0, 0); },
	});

	pi.registerTool({
		name: "hub_await", label: "Hub Await",
		description: "Block until a reply to hub_send arrives or timeout (default 30 min).",
		parameters: Type.Object({ msg_id: Type.String({ description: "msg_id from hub_send." }) }),
		async execute(_callId, params) {
			const pending = pendingReplies.get(params.msg_id);
			if (!pending) return { content: [{ type: "text" as const, text: "unknown msg_id" }], details: { error: "unknown_msg_id" } };
			if (pending.result) { const r = pending.result; if (r.error) return { content: [{ type: "text" as const, text: `error: ${r.error}` }], details: { error: r.error } }; return { content: [{ type: "text" as const, text: typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2) }], details: { response: r.response } }; }
			const timeout = new Promise<{ error: string }>(r => { const t = setTimeout(() => r({ error: "timeout" }), MESSAGE_TIMEOUT_MS); try { (t as any).unref?.(); } catch { /* ignore */ } });
			const winner: any = await Promise.race([pending.promise, timeout]);
			if (winner.error) return { content: [{ type: "text" as const, text: `error: ${winner.error}` }], details: { error: winner.error } };
			return { content: [{ type: "text" as const, text: typeof winner.response === "string" ? winner.response : JSON.stringify(winner.response, null, 2) }], details: { response: winner.response } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("hub_await ")) + theme.fg("warning", (args as any).msg_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { const d = result.details as any; return d?.error ? new Text(theme.fg("error", `✗ ${d.error}`), 0, 0) : new Text(theme.fg("success", "✓ response"), 0, 0); },
	});

	pi.registerTool({
		name: "hub_status", label: "Hub Status",
		description: "Show your connection status, model, context usage, and any pending inbound messages.",
		parameters: Type.Object({}),
		async execute() {
			const ctx = currentCtx;
			const pct = ctx ? Math.round(ctx.getContextUsage()?.percent ?? 0) : 0;
			return { content: [{ type: "text" as const, text: `name: ${identity?.name ?? "?"}\nmodel: ${identity?.model ?? "?"}\ncontext: ${pct}%\ninbound queue: ${inboundQueue.size}\npeers: ${poolAgents.length}\nhub: ${serverUrl}` }], details: { name: identity?.name, model: identity?.model, context_pct: pct, inbound_queue: inboundQueue.size, peers: poolAgents.length } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("hub_status")), 0, 0); },
		renderResult(result, _options, theme) { const d = result.details as any; if (!d) return new Text("", 0, 0); return new Text(theme.fg("accent", `${d.name}`) + theme.fg("dim", ` · ${d.model} · ${d.context_pct}% · ${d.peers} peers`), 0, 0); },
	});

	// ━━ System Prompt: tell LLM about peerstack hub ━━━━━━━━━━━━━━━━━━━
	pi.on("before_agent_start", async (_event) => {
		if (!identity) return {};
		let extra = "";

		// Inject pending inbound messages into system prompt so LLM sees and responds
		const pending = [...inboundQueue.values()].filter(i => !i.fulfilled);
		for (const inbound of pending) {
			extra += `\n[INBOUND from ${inbound.sender_name}]\n${inbound.prompt_text || "..."}\n\nRespond to ${inbound.sender_name} directly. Your response will be automatically sent back.\n`;
		}

		// Inject peer list
		if (poolAgents.length > 0) {
			const peers = poolAgents.map(a => `${a.name}#${shortId(a.session_id)}${isSelf(a) ? " (you)" : ""} (${abbreviateModel(a.model)})`).join(", ");
			extra += `\n<peerstack>\nConnected agents: ${peers}\nUse hub_list, hub_send, hub_await to communicate with peers.\n</peerstack>`;
		}

		if (!extra) return {};
		return { systemPrompt: extra };
	});

	// ━━ /hub slash command for direct user interaction ━━━━━━━━━━━━━━━━━━━
	pi.registerCommand("hub", {
		description: "peerstack hub status and tools",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			if (trimmed === "list" || trimmed === "ls") {
				const agents = await fetchAllAgents();
				if (lastFetchError) {
					ctx.ui.notify(`📡 Hub error: ${lastFetchError}\n  URL: ${serverUrl ?? "?"}\n  Token: ${authToken ? authToken.slice(0, 8) + "..." : "none"}`, "error");
				} else if (agents.length === 0) {
					ctx.ui.notify("📡 No agents on hub.\n  Start agents: stak spawn <name>", "info");
				} else {
					const lines = agents.map(a => `${a.status === "online" ? "●" : a.status === "stale" ? "~" : "✗"} ${a.name}#${shortId(a.session_id)}${isSelf(a) ? " (you)" : ""} (${abbreviateModel(a.model)}) ${Math.round(a.context_used_pct)}% ${a.queue_depth > 0 ? "⚡" : ""}`).join("\n");
					ctx.ui.notify(`📡 ${agents.length} agent(s):\n${lines}`, "info");
				}
			} else if (trimmed === "status" || trimmed === "info") {
				ctx.ui.notify(
					`name: ${identity?.name ?? "?"} #${identity?.session_id ? shortId(identity.session_id) : "?"}\n` +
					`model: ${identity?.model ?? "?"}\n` +
					`status: ${connected ? "connected" : "disconnected"}\n` +
					`hub: ${serverUrl ?? "?"}\n` +
					`agents on hub: ${poolAgents.length}\n` +
					`last fetch error: ${lastFetchError || "none"}\n` +
					`inbound queue: ${inboundQueue.size}`,
					"info"
				);
			} else {
				ctx.ui.notify(
					"📡 peerstack hub commands:\n" +
					"  /hub list       Show connected agents\n" +
					"  /hub status     Show your connection info\n" +
					"\n" +
					"Or ask the agent to use: hub_list, hub_send, hub_await",
					"info"
				);
			}
		},
	});

	// ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	async function cleanShutdown(): Promise<void> {
		if (shuttingDown) return; shuttingDown = true;
		if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
		if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
		if (poolTimer) { clearInterval(poolTimer); poolTimer = null; }
		if (sseAbort) { try { sseAbort.abort(); } catch { /* ignore */ } sseAbort = null; }
		if (identity && serverUrl && authToken) {
			const ac = new AbortController(); const t = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, SHUTDOWN_DELETE_TIMEOUT_MS); try { (t as any).unref?.(); } catch { /* ignore */ }
			try { await api("DELETE", `/v1/agents/${encodeURIComponent(identity.session_id)}`, undefined, { signal: ac.signal }); } catch { /* best-effort */ } finally { clearTimeout(t); }
		}
		if (currentCtx?.hasUI) { try { currentCtx.ui.setWidget("peerstack-pool", undefined); } catch { /* ignore */ } }
	}
	pi.on("session_shutdown", async () => { await cleanShutdown(); });
	process.on("SIGINT", () => { void cleanShutdown(); });
	process.on("SIGTERM", () => { void cleanShutdown(); });
}
