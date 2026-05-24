#!/usr/bin/env bun
/**
 * Integration tests for peerstack hub messaging fixes
 *
 * Run: bun test tests/hub.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_PORT = 52999;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let hubProcess: ReturnType<typeof Bun.spawn> | null = null;
let authToken = "";

const REG_ROOT = path.join(os.homedir(), ".pi", "peerstack");

function randomSessionId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function jsonApi(method: string, path: string, body?: unknown): Promise<any> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  return resp.json();
}

async function openSseAndCollect(sessionId: string, count: number, timeoutMs = 5000): Promise<{ events: Array<{ event: string; data: any }>; reader: ReadableStreamDefaultReader<Uint8Array>; abort: AbortController }> {
  const ac = new AbortController();
  const url = `${BASE_URL}/v1/events?session_id=${encodeURIComponent(sessionId)}`;
  const headers: Record<string, string> = { "Accept": "text/event-stream" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const resp = await fetch(url, { method: "GET", headers, signal: ac.signal });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SSE failed: ${resp.status} ${text}`);
  }
  if (!resp.body) throw new Error("No body");

  const reader = resp.body.getReader();
  const events = await readSseEvents(reader, count, timeoutMs);
  return { events, reader, abort: ac };
}

async function readSseEvents(reader: ReadableStreamDefaultReader<Uint8Array>, count: number, timeoutMs = 5000): Promise<Array<{ event: string; data: any }>> {
  const events: Array<{ event: string; data: any }> = [];
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;

  while (events.length < count && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    let done = false;
    let value: Uint8Array | undefined;
    try {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), Math.min(remaining, 200))),
      ]);
      done = result.done;
      value = result.value;
    } catch (e: any) {
      if (e.message === "timeout") continue;
      throw e;
    }

    if (done) break;
    if (!value) continue;

    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let dataStr = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) dataStr = line.slice(5).trimStart();
      }
      if (dataStr) {
        let data: any = dataStr;
        try { data = JSON.parse(dataStr); } catch { /* string */ }
        events.push({ event, data });
      }
    }
  }
  return events;
}

async function deleteAgent(sessionId: string): Promise<void> {
  try {
    await jsonApi("DELETE", `/v1/agents/${encodeURIComponent(sessionId)}`);
  } catch { /* ignore */ }
}

beforeAll(async () => {
  const serverJsonPath = path.join(REG_ROOT, "server.json");
  try { fs.unlinkSync(serverJsonPath); } catch { /* ignore */ }

  hubProcess = Bun.spawn(["bun", "hub/server.ts"], {
    env: { ...process.env, PEERSTACK_PORT: String(TEST_PORT), PEERSTACK_HOST: "127.0.0.1" },
    stderr: "pipe",
    stdout: "pipe",
  });

  for (let i = 0; i < 50; i++) {
    try {
      const sj = JSON.parse(fs.readFileSync(serverJsonPath, "utf-8")) as { token: string };
      authToken = sj.token;
      const resp = await fetch(`${BASE_URL}/health`, { headers: { "Authorization": `Bearer ${authToken}` } });
      if (resp.ok) break;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
});

afterAll(() => {
  if (hubProcess) {
    hubProcess.kill();
    hubProcess = null;
  }
});

describe("hub messaging", () => {
  test("basic message delivery via SSE", async () => {
    const alice = randomSessionId();
    const bob = randomSessionId();

    try {
      await jsonApi("POST", "/v1/agents/register", { session_id: alice, name: `alice-${Date.now()}`, model: "test", color: "#fff", cwd: "/tmp" });
      await jsonApi("POST", "/v1/agents/register", { session_id: bob, name: `bob-${Date.now()}`, model: "test", color: "#fff", cwd: "/tmp" });

      const { events: initialEvents, reader, abort } = await openSseAndCollect(bob, 2, 2000);
      expect(initialEvents.length).toBe(2);
      expect(initialEvents[0].event).toBe("hello");
      expect(initialEvents[1].event).toBe("pool_snapshot");

      const sendResp = await jsonApi("POST", "/v1/messages", {
        sender_session: alice,
        target: bob,
        prompt: "Hello from Alice!",
      });

      expect(sendResp.ok).toBe(true);
      expect(sendResp.status).toBe("delivered");

      const promptEvents = await readSseEvents(reader, 1, 3000);
      expect(promptEvents.length).toBeGreaterThan(0);
      expect(promptEvents[0].event).toBe("prompt");
      expect(promptEvents[0].data.prompt).toBe("Hello from Alice!");

      abort.abort();
      try { reader.releaseLock(); } catch { /* ignore */ }
    } finally {
      await deleteAgent(alice);
      await deleteAgent(bob);
    }
  });

  test("delivery failure notifies sender when target has no stream", async () => {
    const alice = randomSessionId();
    const ghost = randomSessionId();

    try {
      await jsonApi("POST", "/v1/agents/register", { session_id: alice, name: `alice-${Date.now()}`, model: "test", color: "#fff", cwd: "/tmp" });
      await jsonApi("POST", "/v1/agents/register", { session_id: ghost, name: `ghost-${Date.now()}`, model: "test", color: "#fff", cwd: "/tmp" });

      const sendResp = await jsonApi("POST", "/v1/messages", {
        sender_session: alice,
        target: ghost,
        prompt: "Are you there?",
      });

      expect(sendResp.ok).toBe(true);
      expect(sendResp.status).toBe("error");

      const msgResp = await jsonApi("GET", `/v1/messages/${sendResp.msg_id}`);
      expect(msgResp.status).toBe("error");
      expect(msgResp.error).toBe("target not connected");
    } finally {
      await deleteAgent(alice);
      await deleteAgent(ghost);
    }
  });

  test("message delivery after reconnect", async () => {
    const alice = randomSessionId();
    const bob = randomSessionId();

    try {
      await jsonApi("POST", "/v1/agents/register", { session_id: alice, name: `alice-${Date.now()}`, model: "test", color: "#fff", cwd: "/tmp" });
      await jsonApi("POST", "/v1/agents/register", { session_id: bob, name: `bob-${Date.now()}`, model: "test", color: "#fff", cwd: "/tmp" });

      const { reader: reader1, abort: abort1 } = await openSseAndCollect(bob, 2, 2000);
      abort1.abort();
      try { reader1.releaseLock(); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 300));

      const sendResp = await jsonApi("POST", "/v1/messages", {
        sender_session: alice,
        target: bob,
        prompt: "Message while disconnected",
      });
      expect(sendResp.status).toBe("error");

      const { events: reconnectEvents, reader: reader2, abort: abort2 } = await openSseAndCollect(bob, 2, 2000);
      expect(reconnectEvents.length).toBe(2);

      const sendResp2 = await jsonApi("POST", "/v1/messages", {
        sender_session: alice,
        target: bob,
        prompt: "Message after reconnect",
      });
      expect(sendResp2.status).toBe("delivered");

      const promptEvents = await readSseEvents(reader2, 1, 3000);
      expect(promptEvents.length).toBeGreaterThan(0);
      expect(promptEvents[0].event).toBe("prompt");

      abort2.abort();
      try { reader2.releaseLock(); } catch { /* ignore */ }
    } finally {
      await deleteAgent(alice);
      await deleteAgent(bob);
    }
  });

  test("target not found returns 404", async () => {
    const alice = randomSessionId();
    try {
      await jsonApi("POST", "/v1/agents/register", { session_id: alice, name: `alice-${Date.now()}`, model: "test", color: "#fff", cwd: "/tmp" });

      const sendResp = await jsonApi("POST", "/v1/messages", {
        sender_session: alice,
        target: "nonexistent-agent",
        prompt: "Hello?",
      });

      expect(sendResp.ok).toBe(false);
      expect(sendResp.error).toContain("not found");
    } finally {
      await deleteAgent(alice);
    }
  });

  test("sender not found returns 404", async () => {
    const sendResp = await jsonApi("POST", "/v1/messages", {
      sender_session: "nonexistent-sender",
      target: "bob",
      prompt: "Hello?",
    });

    expect(sendResp.ok).toBe(false);
    expect(sendResp.error).toContain("sender not found");
  });

  test("resolve target by name works", async () => {
    const alice = randomSessionId();
    const bob = randomSessionId();
    const bobName = `bob-${Date.now()}`;

    try {
      await jsonApi("POST", "/v1/agents/register", { session_id: alice, name: `alice-${Date.now()}`, model: "test", color: "#fff", cwd: "/tmp" });
      await jsonApi("POST", "/v1/agents/register", { session_id: bob, name: bobName, model: "test", color: "#fff", cwd: "/tmp" });

      const { reader, abort } = await openSseAndCollect(bob, 2, 2000);

      const sendResp = await jsonApi("POST", "/v1/messages", {
        sender_session: alice,
        target: bobName,
        prompt: "Hello Bob!",
      });

      expect(sendResp.ok).toBe(true);
      expect(sendResp.status).toBe("delivered");

      const promptEvents = await readSseEvents(reader, 1, 3000);
      expect(promptEvents.length).toBeGreaterThan(0);
      expect(promptEvents[0].event).toBe("prompt");

      abort.abort();
      try { reader.releaseLock(); } catch { /* ignore */ }
    } finally {
      await deleteAgent(alice);
      await deleteAgent(bob);
    }
  });

  test("pool_snapshot excludes self", async () => {
    const alice = randomSessionId();
    const bob = randomSessionId();
    const aliceName = `alice-${Date.now()}`;
    const bobName = `bob-${Date.now()}`;

    try {
      await jsonApi("POST", "/v1/agents/register", { session_id: alice, name: aliceName, model: "test", color: "#fff", cwd: "/tmp" });
      await jsonApi("POST", "/v1/agents/register", { session_id: bob, name: bobName, model: "test", color: "#fff", cwd: "/tmp" });

      const { events } = await openSseAndCollect(alice, 2, 2000);

      const snapshot = events.find(e => e.event === "pool_snapshot");
      expect(snapshot).toBeDefined();
      const agentNames = snapshot!.data.agents.map((a: any) => a.name);
      expect(agentNames).toContain(bobName);
      expect(agentNames).not.toContain(aliceName);
    } finally {
      await deleteAgent(alice);
      await deleteAgent(bob);
    }
  });

  test("response flow back to sender", async () => {
    const alice = randomSessionId();
    const bob = randomSessionId();

    try {
      await jsonApi("POST", "/v1/agents/register", { session_id: alice, name: `alice-${Date.now()}`, model: "test", color: "#fff", cwd: "/tmp" });
      await jsonApi("POST", "/v1/agents/register", { session_id: bob, name: `bob-${Date.now()}`, model: "test", color: "#fff", cwd: "/tmp" });

      const { reader: aliceReader, abort: aliceAbort } = await openSseAndCollect(alice, 2, 2000);
      const { reader: bobReader, abort: bobAbort } = await openSseAndCollect(bob, 2, 2000);

      const sendResp = await jsonApi("POST", "/v1/messages", {
        sender_session: alice,
        target: bob,
        prompt: "What is 2+2?",
      });
      expect(sendResp.status).toBe("delivered");

      const bobPromptEvents = await readSseEvents(bobReader, 1, 3000);
      expect(bobPromptEvents.length).toBeGreaterThan(0);
      expect(bobPromptEvents[0].event).toBe("prompt");
      const msgId = bobPromptEvents[0].data.msg_id;

      const responseResp = await jsonApi("POST", `/v1/messages/${msgId}/response`, {
        responder_session: bob,
        response: "4",
      });
      expect(responseResp.ok).toBe(true);

      const aliceEvents = await readSseEvents(aliceReader, 2, 3000);
      const responseEvent = aliceEvents.find(e => e.event === "response");
      expect(responseEvent).toBeDefined();
      expect(responseEvent!.data.response).toBe("4");
      expect(responseEvent!.data.status).toBe("complete");

      aliceAbort.abort();
      bobAbort.abort();
      try { aliceReader.releaseLock(); } catch { /* ignore */ }
      try { bobReader.releaseLock(); } catch { /* ignore */ }
    } finally {
      await deleteAgent(alice);
      await deleteAgent(bob);
    }
  });
});
