#!/usr/bin/env bun
/**
 * peerstack hub — HTTP/SSE server + live terminal dashboard
 *
 * Routes messages between Pi agents, tracks who's talking to who,
 * and displays everything in a live-refreshing terminal UI.
 *
 * Usage:
 *   bun hub/server.ts
 *   PEERSTACK_PORT=52525 bun hub/server.ts
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const HOST = process.env.PEERSTACK_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PEERSTACK_PORT ?? 52525);
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "peerstack");
const ENV_TOKEN = process.env.PEERSTACK_AUTH_TOKEN;

const MAX_HOPS = Number(process.env.PEERSTACK_MAX_HOPS ?? 5);
const MESSAGE_TTL_MS = Number(process.env.PEERSTACK_MESSAGE_TTL_MS ?? 1_800_000);
const MAX_INBOX = Number(process.env.PEERSTACK_MAX_INBOX ?? 100);
const STALE_AFTER_MS = 30_000;
const OFFLINE_AFTER_MS = 60_000;
const STALE_SCAN_INTERVAL_MS = 5_000;
const TTL_SCAN_INTERVAL_MS = 10_000;
const SSE_KEEPALIVE_MS = 15_000;
const DASHBOARD_REFRESH_MS = 500;

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	magenta: "\x1b[35m",
	blue: "\x1b[34m",
};

let TOKEN: string = ENV_TOKEN ?? "";
function isLoopback(host: string): boolean { return host === "127.0.0.1" || host === "::1" || host === "localhost"; }

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

type AgentStatus = "online" | "stale" | "offline";
type Availability = "online" | "busy" | "away" | "offline";
type MessageStatus = "sent" | "queued" | "delivered" | "read" | "complete" | "error" | "timeout";
type MessagePriority = "low" | "normal" | "high" | "urgent";

interface AgentCard {
	session_id: string; name: string; purpose: string; model: string;
	color: string; cwd: string; explicit: boolean;
	description: string; skills: string[]; current_task: string;
	availability: Availability; groups: string[];
	context_used_pct: number; queue_depth: number; status: AgentStatus;
	started_at: string; last_seen_at: string;
}

interface ComsMessage {
	msg_id: string; sender_session: string; target_session: string;
	sender_name: string; target_name: string;
	prompt: string; status: MessageStatus;
	priority: MessagePriority; reply_to?: string; thread_id?: string;
	response?: any; error?: string | null;
	created_at: number; delivered_at?: number; read_at?: number; completed_at?: number;
	// broadcast / multicast
	is_broadcast: boolean; broadcast_id?: string; child_msg_ids?: string[];
}

interface SseWriter { enqueue: (s: string) => void; close: () => void; lastId: number; }

interface LogEntry {
	time: Date; from: string; to: string; msg_id: string; action: string; detail?: string;
}

interface PresenceSubscription {
	subscription_id: string; subscriber_session: string;
	event_types: string[]; created_at: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

const agents = new Map<string, AgentCard>();
const nameIndex = new Map<string, string>();
const messages = new Map<string, ComsMessage>();
const streams = new Map<string, SseWriter>();
const messageLog: LogEntry[] = [];
const conversationTracker = new Map<string, { from: string; to: string; preview: string; time: number }>();
const subscriptions = new Map<string, PresenceSubscription>();
let startupTime = Date.now();

let lastOutput = "";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
	const time = Date.now(); const rand = crypto.randomBytes(10);
	let ts = ""; let t = time; for (let i = 9; i >= 0; i--) { ts = CROCKFORD[t % 32] + ts; t = Math.floor(t / 32); }
	let rs = ""; let bits = 0; let val = 0;
	for (const b of rand) { val = (val << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; rs += CROCKFORD[(val >> bits) & 31]; } }
	return (ts + rs).slice(0, 26);
}

function tokensEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf-8"); const bb = Buffer.from(b, "utf-8");
	if (ab.length !== bb.length) return false; return crypto.timingSafeEqual(ab, bb);
}

function authed(req: Request): boolean {
	if (!TOKEN) return true;
	const h = req.headers.get("authorization") ?? "";
	if (!h.startsWith("Bearer ")) return false; return tokensEqual(h.slice(7), TOKEN);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sse(event: string, data: unknown, id?: number): string {
	const lines = [`event: ${event}`];
	if (id !== undefined) lines.push(`id: ${id}`);
	lines.push(`data: ${JSON.stringify(data)}`);
	return lines.join("\n") + "\n\n";
}

function broadcast(event: string, data: unknown, excludeSession?: string): void {
	for (const [sid, w] of streams) { if (sid === excludeSession) continue; const id = ++w.lastId; try { w.enqueue(sse(event, data, id)); } catch { /* dead */ } }
}

function sendTo(sessionId: string, event: string, data: unknown): void {
	const w = streams.get(sessionId);
	if (!w) return;
	const id = ++w.lastId;
	try { w.enqueue(sse(event, data, id)); } catch { /* closed */ }
}

function notifyPresenceSubscribers(agent: AgentCard): void {
	for (const [, sub] of subscriptions) {
		if (sub.event_types.includes("presence")) {
			sendTo(sub.subscriber_session, "presence_update", {
				agent: {
					session_id: agent.session_id,
					name: agent.name,
					availability: agent.availability,
					status: agent.status,
					current_task: agent.current_task,
				},
				timestamp: nowIso(),
			});
		}
	}
}

function nowIso(): string { return new Date().toISOString(); }

function resolveTarget(nameOrSession: string): AgentCard | undefined {
	const bySession = agents.get(nameOrSession); if (bySession) return bySession;
	const sid = nameIndex.get(nameOrSession); if (sid) return agents.get(sid);
	return undefined;
}

function resolveGroupTarget(groupName: string): AgentCard[] {
	// group names are @name or #name — strip prefix and match against agent groups
	const clean = groupName.replace(/^[@#]/, "").toLowerCase();
	const matches: AgentCard[] = [];
	for (const a of agents.values()) {
		if (a.groups && a.groups.some(g => g.toLowerCase() === clean || g.toLowerCase().replace(/^#/, "") === clean)) {
			matches.push(a);
		}
	}
	return matches;
}

function updateNameIndex(name: string, sessionId: string): void {
	for (const [n, sid] of nameIndex) { if (sid === sessionId && n !== name) nameIndex.delete(n); }
	nameIndex.set(name, sessionId);
}

function log(entry: LogEntry): void {
	messageLog.push(entry);
	if (messageLog.length > 100) messageLog.splice(0, messageLog.length - 100);
}

function timeAgo(ms: number): string {
	let s = Math.floor((Date.now() - ms) / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60); s = s % 60; return `${m}m ${s}s`;
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 3) + "..." : s; }

function padRight(s: string, n: number): string {
	const vis = visibleLen(s);
	return s + " ".repeat(Math.max(0, n - vis));
}

function visibleLen(s: string): number {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").length;
}

function barStr(pct: number, len: number): string {
	const filled = Math.max(0, Math.min(len, Math.round((pct / 100) * len)));
	return C.green + "#".repeat(filled) + C.dim + "-".repeat(len - filled) + C.reset;
}

function shortModel(m: string): string {
	let s = m || "";
	if (s.includes("/")) s = s.split("/").pop() || s;
	if (s.startsWith("claude-")) s = s.slice(7);
	if (s.length > 14) s = s.slice(0, 14);
	return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// Terminal Dashboard
// ═══════════════════════════════════════════════════════════════════════════

function dashboardInit(): void {
	process.stdout.write("\x1b[?1049h\x1b[?25l");
}

function dashboardDone(): void {
	process.stdout.write("\x1b[?25h\x1b[?1049l");
}

function buildDashboard(cols: number): string[] {
	const lines: string[] = [];
	const agentList = [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
	const totalMsgs = messageLog.length;
	const uptime = Math.floor((Date.now() - startupTime) / 1000);

	const header = C.cyan + " peerstack hub " + C.reset +
		C.dim + process.pid + C.reset +
		" | " + C.dim + "up " + uptime + "s" + C.reset +
		" | " + C.bold + agentList.length + C.reset + C.dim + " agent" + (agentList.length !== 1 ? "s" : "") + C.reset +
		" | " + C.bold + totalMsgs + C.reset + C.dim + " msg" + (totalMsgs !== 1 ? "s" : "") + C.reset;
	lines.push(padRight(header, cols));
	lines.push(C.dim + "─".repeat(cols) + C.reset);

	if (agentList.length === 0) {
		lines.push(C.dim + "  waiting for agents to connect..." + C.reset);
	} else {
		for (const a of agentList) {
			const dot = a.status === "online" ? C.green + "●" + C.reset
				: a.status === "stale" ? C.yellow + "○" + C.reset
				: C.red + "●" + C.reset;
			const name = C.bold + a.name + C.reset;
			const model = C.dim + shortModel(a.model) + C.reset;
			const active = a.queue_depth > 0 && a.status === "online" ? C.yellow + " ⚡" + C.reset : "";
			const statusTag = a.status === "online" ? C.green + "online" + C.reset
				: a.status === "stale" ? C.yellow + "stale" + C.reset
				: C.red + "off" + C.reset;
			const filled = Math.max(0, Math.min(8, Math.round((a.context_used_pct / 100) * 8)));
			const bar = C.green + "█".repeat(filled) + C.dim + "█".repeat(8 - filled) + C.reset;
			const pct = C.cyan + String(Math.round(a.context_used_pct)).padStart(3) + "%" + C.reset;
			const avail = a.availability === "busy" ? C.yellow + "⚡" + C.reset
			: a.availability === "away" ? C.dim + "💤" + C.reset
			: "";
		const groups = a.groups && a.groups.length > 0 ? C.dim + " " + a.groups.join(" ") + C.reset : "";
		const line = "  " + dot + " " + name + " " + model + avail + active + "  " + bar + " " + pct + "  " + statusTag + groups;
			lines.push(padRight(line, cols));
		}
	}

	lines.push("");
	lines.push(C.bold + "  ↔ Conversations" + C.reset);
	const convos = [...conversationTracker.values()].sort((a, b) => b.time - a.time).slice(0, 3);
	if (convos.length === 0) {
		lines.push(C.dim + "    (idle)" + C.reset);
	} else {
		for (const c of convos) {
			const ago = C.dim + timeAgo(c.time) + C.reset;
			const preview = truncate(c.preview, Math.max(20, cols - 50));
			const line = "   " + C.cyan + c.from + C.reset + " " + C.dim + "→" + C.reset + " " + C.magenta + c.to + C.reset + "  " + C.dim + preview + C.reset + "  " + ago;
			lines.push(padRight(line, cols));
		}
	}

	lines.push("");
	lines.push(C.bold + "  ↝ Messages" + C.reset);
	const recentLogs = messageLog.slice(-Math.max(2, 6 - agentList.length)).reverse();
	if (recentLogs.length === 0) {
		lines.push(C.dim + "    (waiting)" + C.reset);
	} else {
		for (const l of recentLogs) {
			const ts = C.dim + l.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + C.reset;
			const dir = C.cyan + l.from + C.reset + " " + C.dim + "→" + C.reset + " " + C.magenta + l.to + C.reset;
			const actionColor = l.action === "complete" ? C.green
				: l.action === "error" ? C.red
				: l.action === "delivered" ? C.cyan : C.yellow;
			const action = actionColor + l.action + C.reset;
			const detail = l.detail ? C.dim + l.detail + C.reset : "";
			const line = "  " + ts + "  " + dir + "  " + action + (detail ? " " + detail : "");
			lines.push(padRight(line, cols));
		}
	}

	lines.push("");
	lines.push(C.dim + "─".repeat(cols) + C.reset);
	lines.push(C.dim + "  q quit  |  " + agentList.length + " agent" + (agentList.length !== 1 ? "s" : "") + C.reset);
	return lines;
}

let lastBuiltKey = "";

function dashboardRender(): void {
	const cols = process.stdout.columns ?? 80;
	const rows = process.stdout.rows ?? 24;
	const stateKey = agents.size + "|" + messageLog.length + "|" + conversationTracker.size + "|" +
		[...agents.values()].map(a => Math.round(a.context_used_pct) + "|" + a.queue_depth + "|" + a.status).join(",");
	if (stateKey === lastBuiltKey) return;
	lastBuiltKey = stateKey;
	const lines = buildDashboard(cols);
	const output = lines.slice(0, rows - 1).join("\n");
	if (output === lastOutput) return;
	lastOutput = output;
	process.stdout.write("\x1b[H" + output + "\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// SSE Stream Factory — queue-based pull pattern
// ═══════════════════════════════════════════════════════════════════════════

function createSseStream(session_id: string, initialEvents: string[]): { stream: ReadableStream<Uint8Array>; writer: SseWriter } {
	const enc = new TextEncoder();
	const queue: string[] = [...initialEvents];
	let pullResolve: (() => void) | null = null;
	let closed = false;

	function signalPull() {
		if (pullResolve) { const r = pullResolve; pullResolve = null; r(); }
	}

	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			while (queue.length === 0 && !closed) {
				await new Promise<void>(resolve => { pullResolve = resolve; });
			}
			if (closed && queue.length === 0) return;
			while (queue.length > 0) {
				try { controller.enqueue(enc.encode(queue.shift()!)); } catch { return; }
			}
		},
		cancel() {
			closed = true;
			signalPull();
			streams.delete(session_id);
		},
	});

	const writer: SseWriter = {
		lastId: initialEvents.length,
		enqueue(s: string) {
			if (closed) return;
			queue.push(s);
			signalPull();
		},
		close() {
			closed = true;
			signalPull();
		},
	};

	return { stream, writer };
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Routes
// ═══════════════════════════════════════════════════════════════════════════

async function handleRegister(req: Request): Promise<Response> {
	let body: any;
	try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
	if (!body?.session_id || !body?.name) return json({ ok: false, error: "missing session_id or name" }, 400);

	const session_id = body.session_id;
	const name = body.name;
	const existing = agents.get(session_id);
	const card: AgentCard = {
		session_id, name, purpose: body.purpose ?? "", model: body.model ?? "unknown",
		color: body.color ?? "#888888", cwd: body.cwd ?? "", explicit: body.explicit === true,
		description: body.description ?? existing?.description ?? "",
		skills: Array.isArray(body.skills) ? body.skills : existing?.skills ?? [],
		current_task: body.current_task ?? existing?.current_task ?? "",
		availability: body.availability ?? existing?.availability ?? "online",
		groups: Array.isArray(body.groups) ? body.groups : existing?.groups ?? [],
		context_used_pct: existing?.context_used_pct ?? 0, queue_depth: existing?.queue_depth ?? 0,
		status: "online", started_at: existing?.started_at ?? nowIso(), last_seen_at: nowIso(),
	};
	agents.set(session_id, card);
	updateNameIndex(name, session_id);
	broadcast("agent_joined", { agent: card }, session_id);
	lastBuiltKey = "";
	return json({ ok: true, agent: card, sse_url: `/v1/events?session_id=${encodeURIComponent(session_id)}` });
}

function handleEvents(req: Request, url: URL): Response {
	const session_id = url.searchParams.get("session_id") ?? "";
	if (!session_id) return json({ ok: false, error: "missing session_id" }, 400);
	const entry = agents.get(session_id);
	if (!entry) return json({ ok: false, error: "agent not found" }, 404);

	const hello = sse("hello", { server_time: nowIso() }, 1);
	const agentsList = [...agents.values()].filter(a => a.session_id !== session_id && !a.explicit).map(a => ({
		session_id: a.session_id, name: a.name, model: a.model,
		color: a.color, status: a.status, availability: a.availability,
		description: a.description, skills: a.skills, current_task: a.current_task,
		groups: a.groups, context_used_pct: a.context_used_pct, queue_depth: a.queue_depth,
	}));
	const poolSnap = sse("pool_snapshot", { agents: agentsList }, 2);

	const { stream, writer } = createSseStream(session_id, [hello, poolSnap]);

	const old = streams.get(session_id);
	if (old) { try { old.close(); } catch { /* noop */ } }
	streams.set(session_id, writer);

	// Redeliver queued messages
	const queuedForTarget = [...messages.values()].filter(m => m.target_session === session_id && m.status === "queued");
	for (const msg of queuedForTarget) {
		const sender = agents.get(msg.sender_session);
		sendTo(session_id, "prompt", {
			msg_id: msg.msg_id,
			sender: { session_id: msg.sender_session, name: msg.sender_name, cwd: sender?.cwd ?? "" },
			prompt: msg.prompt, hops: 0,
		});
		msg.status = "delivered";
		msg.delivered_at = Date.now();
		if (sender) sendTo(msg.sender_session, "message_status", { msg_id: msg.msg_id, status: "delivered" });
	}

	req.signal.addEventListener("abort", () => {
		writer.close();
		const left = agents.get(session_id);
		if (left) broadcast("agent_left", { session_id, name: left.name }, session_id);
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-store, must-revalidate",
			"pragma": "no-cache",
			"expires": "0",
			"connection": "keep-alive",
			"x-accel-buffering": "no",
			"access-control-allow-origin": "*",
		},
	});
}

async function handleHeartbeat(req: Request, sessionId: string): Promise<Response> {
	let body: any;
	try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
	const entry = agents.get(sessionId);
	if (!entry) return json({ ok: false, error: "agent not found" }, 404);

	if (typeof body.context_used_pct === "number") entry.context_used_pct = body.context_used_pct;
	if (typeof body.queue_depth === "number") entry.queue_depth = body.queue_depth;
	if (typeof body.model === "string") entry.model = body.model;
	if (typeof body.description === "string") entry.description = body.description;
	if (Array.isArray(body.skills)) entry.skills = body.skills;
	if (typeof body.current_task === "string") entry.current_task = body.current_task;
	if (typeof body.availability === "string") entry.availability = body.availability as Availability;
	if (Array.isArray(body.groups)) entry.groups = body.groups;

	const prevAvailability = entry.availability;
	const prevStatus = entry.status;
	entry.status = "online";
	entry.last_seen_at = nowIso();

	// Notify presence subscribers on status/availability change
	if (prevStatus !== "online" || prevAvailability !== entry.availability) {
		notifyPresenceSubscribers(entry);
	}

	return json({ ok: true });
}

function handleListAgents(): Response {
	return json({ agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)) });
}

function handleGetMessage(msg_id: string): Response {
	const m = messages.get(msg_id);
	if (!m) return json({ ok: false, error: "not found" }, 404);

	// If broadcast, aggregate child message statuses
	if (m.is_broadcast && m.child_msg_ids) {
		const childStatuses: Record<string, any> = {};
		const responses: any[] = [];
		let allDone = true;
		let hasError = false;
		for (const cid of m.child_msg_ids) {
			const child = messages.get(cid);
			if (!child) continue;
			childStatuses[cid] = { status: child.status, target: child.target_name, error: child.error };
			if (child.status === "complete") {
				responses.push({ target: child.target_name, session_id: child.target_session, response: child.response });
			} else if (child.status === "error") {
				hasError = true;
				responses.push({ target: child.target_name, session_id: child.target_session, error: child.error });
			} else {
				allDone = false;
			}
		}
		const aggStatus: MessageStatus = allDone ? (hasError ? "error" : "complete") : "delivered";
		return json({
			msg_id: m.msg_id,
			status: aggStatus,
			is_broadcast: true,
			child_count: m.child_msg_ids.length,
			child_statuses: childStatuses,
			responses,
			error: hasError && allDone ? "some targets returned errors" : null,
		});
	}

	return json({
		msg_id: m.msg_id,
		status: m.status,
		response: m.response ?? null,
		error: m.error ?? null,
		priority: m.priority,
		reply_to: m.reply_to ?? null,
		thread_id: m.thread_id ?? null,
	});
}

async function handleSendMessage(req: Request): Promise<Response> {
	let body: any;
	try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }

	// Support both `target` (string) and `targets` (array)
	const rawTargets: string[] = [];
	if (typeof body.target === "string") rawTargets.push(body.target);
	if (Array.isArray(body.targets)) rawTargets.push(...body.targets);
	if (rawTargets.length === 0 || !body?.sender_session || !body?.prompt) {
		return json({ ok: false, error: "missing fields: sender_session, prompt, and target(s) required" }, 400);
	}

	const sender = agents.get(body.sender_session);
	if (!sender) return json({ ok: false, error: "sender not found" }, 404);

	const hops = typeof body.hops === "number" ? body.hops : 0;
	if (hops >= MAX_HOPS) return json({ ok: false, error: "hop limit exceeded" }, 409);

	// Resolve targets: strings may be agent names, session_ids, or @group references
	const resolvedTargets: AgentCard[] = [];
	for (const t of rawTargets) {
		if (t.startsWith("@") || t.startsWith("#")) {
			// Group target
			const groupMembers = resolveGroupTarget(t);
			for (const m of groupMembers) {
				if (!resolvedTargets.find(r => r.session_id === m.session_id)) {
					resolvedTargets.push(m);
				}
			}
		} else {
			const target = resolveTarget(t);
			if (!target) return json({ ok: false, error: `target "${t}" not found` }, 404);
			if (!resolvedTargets.find(r => r.session_id === target.session_id)) {
				resolvedTargets.push(target);
			}
		}
	}

	if (resolvedTargets.length === 0) {
		return json({ ok: false, error: "no valid targets resolved" }, 404);
	}

	const priority: MessagePriority = body.priority ?? "normal";
	const reply_to: string | undefined = body.reply_to;
	const thread_id: string | undefined = body.thread_id;
	const isBroadcast = resolvedTargets.length > 1;

	// Sort targets by priority (urgent first) for queue preemption
	const priorityOrder: Record<MessagePriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

	// For broadcast: create a parent message + child messages
	const broadcast_id = isBroadcast ? ulid() : undefined;
	const now = Date.now();
	const createdMsgIds: string[] = [];

	for (const target of resolvedTargets) {
		const depth = [...messages.values()].filter(m =>
			m.target_session === target.session_id &&
			(m.status === "sent" || m.status === "queued" || m.status === "delivered" || m.status === "read")
		).length;
		if (depth >= MAX_INBOX) {
			// Skip full inboxes in broadcast; report as individual error
			const errMsgId = ulid();
			const errMsg: ComsMessage = {
				msg_id: errMsgId, sender_session: body.sender_session, target_session: target.session_id,
				sender_name: sender.name, target_name: target.name,
				prompt: body.prompt, status: "error", priority,
				reply_to, thread_id, error: "inbox full",
				created_at: now, completed_at: now,
				is_broadcast: false, broadcast_id,
			};
			messages.set(errMsgId, errMsg);
			createdMsgIds.push(errMsgId);
			continue;
		}

		const msg_id = ulid();
		const msg: ComsMessage = {
			msg_id, sender_session: body.sender_session, target_session: target.session_id,
			sender_name: sender.name, target_name: target.name,
			prompt: body.prompt, status: "sent", priority,
			reply_to, thread_id,
			created_at: now,
			is_broadcast: false, broadcast_id,
		};
		messages.set(msg_id, msg);
		createdMsgIds.push(msg_id);
		conversationTracker.set(msg_id, { from: sender.name, to: target.name, preview: body.prompt, time: now });

		const targetStream = streams.get(target.session_id);
		if (targetStream) {
			sendTo(target.session_id, "prompt", {
				msg_id, sender: { session_id: sender.session_id, name: sender.name, cwd: sender.cwd },
				prompt: body.prompt, hops,
				reply_to, thread_id, priority,
			});
			msg.status = "delivered"; msg.delivered_at = Date.now();
			sendTo(body.sender_session, "message_status", { msg_id, status: "delivered" });
		} else {
			msg.status = "error"; msg.error = "target not connected"; msg.completed_at = Date.now();
			sendTo(body.sender_session, "message_status", { msg_id, status: "error", error: "target not connected" });
		}

		log({ time: new Date(), from: sender.name, to: target.name, msg_id, action: msg.status, detail: body.prompt.length > 30 ? body.prompt.slice(0, 30) + "..." : body.prompt });
	}

	// For broadcasts, return the broadcast_id. For single-target, return the child msg_id.
	const returnMsgId = isBroadcast ? broadcast_id! : createdMsgIds[0];

	// If broadcast, create a tracking entry
	if (isBroadcast && broadcast_id) {
		const broadcastMsg: ComsMessage = {
			msg_id: broadcast_id, sender_session: body.sender_session, target_session: "",
			sender_name: sender.name, target_name: resolvedTargets.map(t => t.name).join(", "),
			prompt: body.prompt, status: "sent", priority,
			reply_to, thread_id,
			created_at: now,
			is_broadcast: true, child_msg_ids: createdMsgIds,
		};
		messages.set(broadcast_id, broadcastMsg);
	}

	lastBuiltKey = "";
	const firstChild = createdMsgIds.length > 0 ? messages.get(createdMsgIds[0]) : null;
	const returnStatus = isBroadcast ? "sent" : (firstChild?.status ?? "sent");
	return json({
		ok: true,
		msg_id: returnMsgId,
		status: returnStatus,
		is_broadcast: isBroadcast,
		target_count: resolvedTargets.length,
		target_session: isBroadcast ? undefined : resolvedTargets[0]?.session_id,
		child_msg_ids: isBroadcast ? createdMsgIds : undefined,
	});
}

async function handleMarkRead(req: Request, msg_id: string): Promise<Response> {
	let body: any;
	try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
	if (!body?.reader_session) return json({ ok: false, error: "missing reader_session" }, 400);
	const msg = messages.get(msg_id);
	if (!msg) return json({ ok: false, error: "message not found" }, 404);
	if (body.reader_session !== msg.target_session) return json({ ok: false, error: "not the target" }, 403);
	if (msg.status === "delivered") {
		msg.status = "read";
		msg.read_at = Date.now();
		sendTo(msg.sender_session, "message_status", { msg_id, status: "read" });
	}
	return json({ ok: true, status: msg.status });
}

async function handleSubmitResponse(req: Request, msg_id: string): Promise<Response> {
	let body: any;
	try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
	if (!body?.responder_session) return json({ ok: false, error: "missing responder_session" }, 400);
	const msg = messages.get(msg_id);
	if (!msg) return json({ ok: false, error: "message not found" }, 404);
	if (body.responder_session !== msg.target_session) return json({ ok: false, error: "not the target" }, 403);
	if (msg.status === "complete" || msg.status === "error" || msg.status === "timeout") return json({ ok: false, error: "already complete" }, 409);

	const isError = body.error != null;
	msg.status = isError ? "error" : "complete";
	msg.response = body.response ?? null;
	msg.error = isError ? String(body.error) : null;
	msg.read_at = Date.now();
	msg.completed_at = Date.now();

	sendTo(msg.sender_session, "response", { msg_id, response: msg.response, error: msg.error, status: msg.status });
	sendTo(msg.sender_session, "message_status", { msg_id, status: msg.status });

	const responder = agents.get(body.responder_session);
	const responseLen = typeof msg.response === "string" ? msg.response.length : JSON.stringify(msg.response).length;
	log({ time: new Date(), from: responder?.name ?? "?", to: msg.sender_name, msg_id, action: msg.status, detail: isError ? "error" : (responseLen > 100 ? Math.round(responseLen / 100) * 100 + "b" : responseLen + "b") });
	lastBuiltKey = "";
	return json({ ok: true });
}

function handleDeleteAgent(sessionId: string): Response {
	const entry = agents.get(sessionId);
	if (!entry) return json({ ok: false, error: "not found" }, 404);
	const stream = streams.get(sessionId);
	if (stream) { try { stream.close(); } catch { /* noop */ } streams.delete(sessionId); }
	agents.delete(sessionId);
	for (const [n, sid] of nameIndex) { if (sid === sessionId) nameIndex.delete(n); }
	broadcast("agent_left", { session_id: sessionId, name: entry.name }, sessionId);
	lastBuiltKey = "";
	return json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Cleanup loops
// ═══════════════════════════════════════════════════════════════════════════

function staleScan(): void {
	const now = Date.now(); let changed = false;
	for (const [sid, card] of agents) {
		const last = Date.parse(card.last_seen_at);
		if (Number.isNaN(last)) continue;
		const dt = now - last;
		if (dt > OFFLINE_AFTER_MS) {
			card.availability = "offline";
			notifyPresenceSubscribers(card);
			agents.delete(sid); nameIndex.delete(card.name);
			const s = streams.get(sid); if (s) { try { s.close(); } catch { /* noop */ } streams.delete(sid); }
			broadcast("agent_left", { session_id: sid, name: card.name, reason: "offline" }, sid);
			changed = true;
		} else if (dt > STALE_AFTER_MS && card.status !== "stale") {
			card.status = "stale";
			if (card.availability === "online") card.availability = "away";
			notifyPresenceSubscribers(card);
			changed = true;
			broadcast("agent_stale", { session_id: sid, name: card.name, last_seen_at: card.last_seen_at }, sid);
		}
	}
	if (changed) lastBuiltKey = "";
}

function ttlScan(): void {
	const inFlight: MessageStatus[] = ["sent", "queued", "delivered", "read"];
	for (const [id, m] of messages) {
		if (m.status === "complete" || m.status === "error" || m.status === "timeout") {
			if (m.completed_at && Date.now() - m.completed_at > MESSAGE_TTL_MS) messages.delete(id);
		} else if (inFlight.includes(m.status) && Date.now() - m.created_at > MESSAGE_TTL_MS) {
			m.status = "timeout"; m.error = "expired"; m.completed_at = Date.now();
			sendTo(m.sender_session, "message_status", { msg_id: id, status: "timeout", error: "expired" });
			setTimeout(() => messages.delete(id), 1000);
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Capabilities
// ═══════════════════════════════════════════════════════════════════════════

function handleCapabilities(url: URL): Response {
	const skill = url.searchParams.get("skill")?.toLowerCase();
	const topic = url.searchParams.get("topic")?.toLowerCase();
	const group = url.searchParams.get("group")?.toLowerCase();

	let results: AgentCard[] = [...agents.values()];

	if (skill) {
		results = results.filter(a =>
			a.skills.some(s => s.toLowerCase().includes(skill)) ||
			a.description.toLowerCase().includes(skill)
		);
	}
	if (topic) {
		results = results.filter(a =>
			a.skills.some(s => s.toLowerCase().includes(topic)) ||
			a.description.toLowerCase().includes(topic) ||
			a.name.toLowerCase().includes(topic)
		);
	}
	if (group) {
		results = results.filter(a =>
			a.groups.some(g => g.toLowerCase().replace(/^#/, "") === group)
		);
	}

	return json({
		ok: true,
		count: results.length,
		agents: results.map(a => ({
			session_id: a.session_id,
			name: a.name,
			description: a.description,
			skills: a.skills,
			current_task: a.current_task,
			availability: a.availability,
			groups: a.groups,
			model: a.model,
			status: a.status,
		})),
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// Subscriptions
// ═══════════════════════════════════════════════════════════════════════════

async function handleCreateSubscription(req: Request): Promise<Response> {
	let body: any;
	try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
	if (!body?.subscriber_session || !body?.event_types) {
		return json({ ok: false, error: "missing subscriber_session or event_types" }, 400);
	}

	const subscriber = agents.get(body.subscriber_session);
	if (!subscriber) return json({ ok: false, error: "subscriber not found" }, 404);

	const subscription_id = ulid();
	const sub: PresenceSubscription = {
		subscription_id,
		subscriber_session: body.subscriber_session,
		event_types: body.event_types,
		created_at: Date.now(),
	};
	subscriptions.set(subscription_id, sub);

	return json({ ok: true, subscription_id, event_types: sub.event_types });
}

function handleDeleteSubscription(req: Request, url: URL): Response {
	const subscription_id = url.searchParams.get("subscription_id") ?? "";
	if (!subscription_id) return json({ ok: false, error: "missing subscription_id" }, 400);
	const sub = subscriptions.get(subscription_id);
	if (!sub) return json({ ok: false, error: "subscription not found" }, 404);
	subscriptions.delete(subscription_id);
	return json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════════════════

async function router(req: Request): Promise<Response> {
	let url: URL;
	try { url = new URL(req.url); } catch { return json({ ok: false, error: "invalid_url" }, 400); }
	const method = req.method.toUpperCase();
	const pathname = url.pathname;

	if (pathname === "/health" && method === "GET") return json({ ok: true, uptime: Math.floor((Date.now() - startupTime) / 1000) });

	if (pathname.startsWith("/v1/")) {
		if (TOKEN && !authed(req)) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="peerstack"' } });
	} else return json({ ok: false, error: "not_found" }, 404);

	if (pathname === "/v1/agents/register" && method === "POST") return handleRegister(req);
	if (pathname === "/v1/events" && method === "GET") return handleEvents(req, url);
	if (pathname === "/v1/agents" && method === "GET") return handleListAgents();
	if (pathname === "/v1/messages" && method === "POST") return handleSendMessage(req);
	if (pathname === "/v1/capabilities" && method === "GET") return handleCapabilities(url);
	if (pathname === "/v1/subscriptions" && method === "POST") return handleCreateSubscription(req);
	if (pathname === "/v1/subscriptions" && method === "DELETE") return handleDeleteSubscription(req, url);

	const agentMatch = pathname.match(/^\/v1\/agents\/([^/]+)(?:\/(heartbeat))?$/);
	if (agentMatch) {
		const sid = decodeURIComponent(agentMatch[1]); const tail = agentMatch[2];
		if (tail === "heartbeat" && method === "POST") return handleHeartbeat(req, sid);
		if (!tail && method === "DELETE") return handleDeleteAgent(sid);
		return json({ ok: false, error: "method_not_allowed" }, 405);
	}

	const msgMatch = pathname.match(/^\/v1\/messages\/([^/]+)(?:\/(response|read))?$/);
	if (msgMatch) {
		const mid = decodeURIComponent(msgMatch[1]); const tail = msgMatch[2];
		if (!tail && method === "GET") return handleGetMessage(mid);
		if (tail === "response" && method === "POST") return handleSubmitResponse(req, mid);
		if (tail === "read" && method === "POST") return handleMarkRead(req, mid);
		return json({ ok: false, error: "method_not_allowed" }, 405);
	}

	return json({ ok: false, error: "not_found" }, 404);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

function main(): void {
	if (!TOKEN) {
		if (!isLoopback(HOST)) { console.error("peerstack: refusing to bind " + HOST + " without PEERSTACK_AUTH_TOKEN"); process.exit(1); }
		TOKEN = crypto.randomBytes(32).toString("hex");
	}

	const dir = CONFIG_DIR;
	fs.mkdirSync(dir, { recursive: true });

	const server = Bun.serve({ hostname: HOST, port: PORT, fetch: router, idleTimeout: 0 });
	const claimedPort: number = Number(server.port);
	const localHost = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
	const localUrl = "http://" + localHost + ":" + claimedPort;

	const serverJsonPath = path.join(dir, "server.json");
	const tmp = serverJsonPath + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify({ local_url: localUrl, token: TOKEN, port: claimedPort, pid: process.pid }));
	fs.renameSync(tmp, serverJsonPath);

	const staleTimer = setInterval(staleScan, STALE_SCAN_INTERVAL_MS);
	const ttlTimer = setInterval(ttlScan, TTL_SCAN_INTERVAL_MS);
	const keepaliveTimer = setInterval(() => {
		const frame = ": ping " + nowIso() + "\n\n";
		for (const [, w] of streams) { try { w.enqueue(frame); } catch { /* dead */ } }
	}, SSE_KEEPALIVE_MS);

	dashboardInit();
	process.stdout.write("peerstack hub: listening on " + localUrl + "\n");

	let dashboardTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleDashboard() {
		if (dashboardTimer) return;
		dashboardTimer = setTimeout(() => {
			dashboardTimer = null;
			dashboardRender();
			scheduleDashboard();
		}, DASHBOARD_REFRESH_MS);
	}
	scheduleDashboard();

	readline.emitKeypressEvents(process.stdin as any);
	if (process.stdin.isTTY) {
		process.stdin.setRawMode!(true);
		process.stdin.on("keypress", (_str, key) => {
			if (key.name === "q" || (key.ctrl && key.name === "c")) {
				cleanShutdown(server, staleTimer, ttlTimer, keepaliveTimer, serverJsonPath);
			}
		});
	}

	process.on("SIGINT", () => { cleanShutdown(server, staleTimer, ttlTimer, keepaliveTimer, serverJsonPath); });
	process.on("SIGTERM", () => { cleanShutdown(server, staleTimer, ttlTimer, keepaliveTimer, serverJsonPath); });
}

function cleanShutdown(server: any, staleTimer: any, ttlTimer: any, keepaliveTimer: any, serverJsonPath: string): void {
	dashboardDone();
	clearInterval(staleTimer);
	clearInterval(ttlTimer);
	clearInterval(keepaliveTimer);
	try { fs.unlinkSync(serverJsonPath); } catch { /* ignore */ }
	try { server.stop?.(true); } catch { /* ignore */ }
	console.log("peerstack hub: shutdown");
	process.exit(0);
}

if (import.meta.main) { main(); }
