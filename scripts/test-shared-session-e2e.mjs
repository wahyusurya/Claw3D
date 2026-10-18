#!/usr/bin/env node
/**
 * E2E test for the shared-session (office↔Telegram) adapter changes.
 * Runs the patched adapter standalone on HERMES_ADAPTER_PORT (default 18790)
 * against a DEDICATED test session — no containers, no live Telegram session.
 *
 * Usage (from ~/claw3d, with HERMES_API_KEY set):
 *   HERMES_API_KEY=*** node scripts/test-shared-session-e2e.mjs
 *
 * Checks:
 *   A. chat.send (Secretary) runs in the shared session and returns the reply
 *   B. chat.history (Secretary) shows the shared transcript
 *   C. the turn is stored in the Hermes session (Sessions API)
 *   D. sub-agent chat works via the local loop (delegation path)
 *   E. sub-agent replies do NOT leak into the shared session
 *   F. sessions.reset never destroys the session
 *   G0. office turns are not echoed by the live sync
 *   G. a turn made outside the office (as from Telegram) reaches a connected office live
 *   FT1-5. full-tools agents: real tools, isolation, fresh session on NEW REQUEST, abort stops Hermes
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const API = process.env.HERMES_API_URL || "http://127.0.0.1:8643";
const KEY = process.env.HERMES_API_KEY || "";
const PORT = Number(process.env.E2E_ADAPTER_PORT || 18790);
const HOME_DIR = "/tmp/office-e2e-home";

if (!KEY) {
  console.error("HERMES_API_KEY is required");
  process.exit(1);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const apiHeaders = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function apiGet(path) {
  const res = await fetch(`${API}${path}`, { headers: apiHeaders });
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: apiHeaders, body: JSON.stringify(body) });
  return res.json();
}

/** Open adapter WS, handshake, run fn(session), always returns a cleanup-safe handle. */
function withAdapter(port, fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let nextId = 1;
    const pending = new Map();
    const chatWaiters = new Set();
    const send = (method, params) => new Promise((res2, rej2) => {
      const id = String(nextId++);
      pending.set(id, { res: res2, rej: rej2 });
      ws.send(JSON.stringify({ type: "req", id, method, params: params || {} }));
    });
    ws.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (frame.type === "res") {
        const p = pending.get(frame.id);
        if (!p) return;
        pending.delete(frame.id);
        frame.ok ? p.res(frame.payload) : p.rej(new Error(frame.error?.message || "request failed"));
      } else if (frame.type === "event" && frame.event === "chat") {
        for (const w of chatWaiters) w(frame.payload);
      }
    });
    ws.on("error", reject);
    ws.on("open", () => {
      send("connect", {}).then(() => fn({ send, chatWaiters })).then((value) => { ws.close(); resolve(value); }).catch((err) => { ws.close(); reject(err); });
    });
  });
}

function chatRoundTrip(session, sessionKey, message, timeoutMs = 180_000) {
  return new Promise(async (resolve, reject) => {
    let runId = null;
    const waiter = (p) => {
      if (!runId && p.runId) runId = p.runId;
      if (p.runId && runId && p.runId !== runId) return;
      if (p.state === "final") { session.chatWaiters.delete(waiter); resolve(p.message?.content ?? ""); }
      else if (p.state === "error") { session.chatWaiters.delete(waiter); reject(new Error(p.errorMessage || "chat error")); }
      else if (p.state === "aborted") { session.chatWaiters.delete(waiter); reject(new Error("aborted")); }
    };
    session.chatWaiters.add(waiter);
    setTimeout(() => { session.chatWaiters.delete(waiter); reject(new Error("chat timeout")); }, timeoutMs);
    await session.send("chat.send", { sessionKey, message });
  });
}

// ---------------------------------------------------------------------------
const SESSION_MODEL = process.env.CLAW3D_SHARED_SESSION_MODEL || "";
const created = await apiPost("/api/sessions", SESSION_MODEL
  ? { title: `e2e-shared-${Date.now()}`, model: SESSION_MODEL }
  : { title: `e2e-shared-${Date.now()}` });
const SID = created?.session?.id;
if (!SID) {
  console.error("could not create test session:", JSON.stringify(created).slice(0, 300));
  process.exit(1);
}
console.log(`test session: ${SID}`);

rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.hermes`, { recursive: true });

const child = spawn(process.execPath, ["server/hermes-gateway-adapter.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)), // repo root, wherever it is checked out
  env: {
    ...process.env,
    HOME: HOME_DIR,
    HERMES_ADAPTER_PORT: String(PORT),
    HERMES_API_URL: process.env.HERMES_API_URL || "http://127.0.0.1:8643",
    HERMES_MODEL: process.env.HERMES_MODEL || "claw3d",
    HERMES_AGENT_NAME: process.env.HERMES_AGENT_NAME || "Claw3D",
    CLAW3D_SHARED_SESSION: "on",
    CLAW3D_SHARED_SYNC_MS: "2000",
    CLAW3D_SHARED_SESSION_ID: SID,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write(`[adapter] ${d}`));
child.stderr.on("data", (d) => process.stdout.write(`[adapter:err] ${d}`));

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("adapter did not start in 15s")), 15_000);
  child.stdout.on("data", (d) => { if (d.toString().includes("Listening")) { clearTimeout(t); resolve(); } });
});

try {
  await withAdapter(PORT, async (session) => {
    // A. Secretary turn runs in the shared session
    const reply = await chatRoundTrip(session, "agent:hermes:main", "Reply with exactly: adapter-e2e-ok");
    check("A. secretary chat round-trip via shared session", reply.includes("adapter-e2e-ok"), reply.slice(0, 80));

    // B. chat.history returns the shared transcript
    const hist = await session.send("chat.history", { sessionKey: "agent:hermes:main" });
    const msgs = hist.messages || [];
    const hasPair = msgs.some((m) => m.role === "user" && m.content.includes("adapter-e2e-ok"))
      && msgs.some((m) => m.role === "assistant" && m.content.includes("adapter-e2e-ok"));
    check("B. chat.history shows shared transcript", hasPair, `${msgs.length} messages`);

    // C. the turn is really stored in the Hermes session
    const stored = await apiGet(`/api/sessions/${SID}/messages`);
    const rows = stored.data || [];
    const storedPair = rows.some((m) => m.role === "user" && (m.content || "").includes("adapter-e2e-ok"))
      && rows.some((m) => m.role === "assistant" && (m.content || "").includes("adapter-e2e-ok"));
    check("C. turn stored in shared Hermes session", storedPair, `${rows.length} rows`);

    // D. sub-agent chat via the local loop (delegation path)
    const created2 = await session.send("agents.create", {
      name: "E2eTester", role: "tester", systemPrompt: "You are E2eTester. Answer with short confirmations only.",
    });
    const subId = created2.agentId;
    check("D0. sub-agent created", Boolean(subId), String(subId));
    const subReply = await chatRoundTrip(session, `agent:${subId}:main`, "Reply with exactly: sub-e2e-ok");
    check("D. sub-agent chat round-trip (local loop)", subReply.includes("sub-e2e-ok"), subReply.slice(0, 80));

    // E. sub-agent reply must NOT leak into the shared session
    const stored2 = await apiGet(`/api/sessions/${SID}/messages`);
    const leak = (stored2.data || []).some((m) => (m.content || "").includes("sub-e2e-ok"));
    check("E. sub-agent reply isolated from shared session", !leak);

    // FT. full-tools sub-agent: real toolset via its own private Hermes session,
    // isolated from the shared session.
    const ft = await session.send("agents.create", {
      name: "E2eTools", role: "tester", fullTools: true,
      systemPrompt: "You are E2eTools, a terse worker agent.",
    });
    const ftReply = await chatRoundTrip(session, `agent:${ft.agentId}:main`,
      "Use the terminal tool to run exactly: echo subtool-7788 — then reply with exactly: agenttools-ok", 300_000);
    check("FT1. full-tools sub-agent runs real tools", ftReply.includes("agenttools-ok"), ftReply.slice(0, 80));
    const roster = JSON.parse(readFileSync(`${HOME_DIR}/.hermes/claw3d-agents.json`, "utf8"));
    const ftEntry = (roster.agents || []).find((a) => a.id === ft.agentId);
    const ftRows = ftEntry?.sessionApiId
      ? (await apiGet(`/api/sessions/${ftEntry.sessionApiId}/messages`)).data || [] : [];
    const toolRan = ftRows.some((m) => m.role === "tool")
      && ftRows.some((m) => String(m.content || "").includes("subtool-7788"));
    check("FT2. full-tools tool output recorded", toolRan, `${ftRows.length} rows`);
    const ftLeak = (await apiGet(`/api/sessions/${SID}/messages`)).data || [];
    check("FT3. full-tools reply isolated from shared session",
      !ftLeak.some((m) => String(m.content || "").includes("agenttools-ok")));
    // FT4. a "NEW REQUEST" brief starts the agent in a fresh session; a follow-up keeps it.
    const ftSessionOf = () => (JSON.parse(readFileSync(`${HOME_DIR}/.hermes/claw3d-agents.json`, "utf8")).agents || [])
      .find((a) => a.id === ft.agentId)?.sessionApiId;
    await chatRoundTrip(session, `agent:${ft.agentId}:main`, "[Team] NEW REQUEST: reply with exactly: fresh-ok", 300_000);
    await new Promise((r) => setTimeout(r, 500)); // roster save is debounced
    const freshSid = ftSessionOf();
    await chatRoundTrip(session, `agent:${ft.agentId}:main`, "[Team] Follow-up: reply with exactly: same-ok", 300_000);
    await new Promise((r) => setTimeout(r, 500));
    check("FT4. NEW REQUEST → fresh session, follow-up keeps it",
      Boolean(freshSid) && freshSid !== ftEntry?.sessionApiId && ftSessionOf() === freshSid,
      `${ftEntry?.sessionApiId} → ${freshSid} → ${ftSessionOf()}`);
    // FT5. chat.abort really stops the Hermes run: abort while a long command runs (on a timer —
    // Hermes >= 0.22 no longer streams tool.started for session chats); its output must never land.
    const ftKey = `agent:${ft.agentId}:main`;
    const abortOutcome = await new Promise((resolve) => {
      const waiter = (p) => {
        if (p.sessionKey !== ftKey || !["aborted", "final", "error"].includes(p.state)) return;
        session.chatWaiters.delete(waiter);
        resolve(p.state);
      };
      session.chatWaiters.add(waiter);
      setTimeout(() => session.send("chat.abort", { sessionKey: ftKey }).catch(() => {}), 30_000);
      setTimeout(() => { session.chatWaiters.delete(waiter); resolve("timeout"); }, 240_000);
      session.send("chat.send", { sessionKey: ftKey,
        message: "[Team] Use the terminal tool once to run exactly: `sleep 60 && echo stopstep-late`. Then reply: done." });
    });
    await new Promise((r) => setTimeout(r, 60_000)); // long enough for the command to finish if the run kept going
    const stopRows = freshSid ? (await apiGet(`/api/sessions/${freshSid}/messages`)).data || [] : [];
    const ranLate = stopRows.some((m) => m.role === "tool" && String(m.content).includes("stopstep-late"));
    check("FT5. chat.abort stops the Hermes run", abortOutcome === "aborted" && !ranLate,
      `outcome=${abortOutcome} lateSteps=${ranLate}`);
    for (const sid of new Set([ftEntry?.sessionApiId, freshSid].filter(Boolean))) {
      await fetch(`${API}/api/sessions/${sid}`, { method: "DELETE", headers: apiHeaders });
    }
    await session.send("agents.delete", { agentId: ft.agentId });

    // F. sessions.reset must not destroy the session
    const reset = await session.send("sessions.reset", { key: "agent:hermes:main" });
    const after = await apiGet(`/api/sessions/${SID}`);
    check("F. sessions.reset non-destructive", Boolean(after?.session?.id) && reset.ok === true,
      JSON.stringify(reset).slice(0, 80));

    // G0/G. live sync: collect shared-sync finals for the main session from here on.
    const syncedFinals = [];
    const syncListener = (p) => {
      if (p.state === "final" && p.sessionKey === "agent:hermes:main" && String(p.runId || "").startsWith("shared-sync-")) {
        syncedFinals.push(String(p.message?.content ?? ""));
      }
    };
    session.chatWaiters.add(syncListener);
    await new Promise((r) => setTimeout(r, 5000)); // > 2 polls after the office turns above
    check("G0. office turns not echoed by live sync", syncedFinals.length === 0, `${syncedFinals.length} echoes`);
    // Simulate a Telegram turn: write straight into the shared Hermes session, bypassing the adapter.
    await apiPost(`/api/sessions/${SID}/chat`, { input: "Reply with exactly: telegram-sync-ok" });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !syncedFinals.some((t) => t.includes("telegram-sync-ok"))) {
      await new Promise((r) => setTimeout(r, 500));
    }
    session.chatWaiters.delete(syncListener);
    check("G. outside turn reaches connected office live", syncedFinals.some((t) => t.includes("telegram-sync-ok")),
      `${syncedFinals.length} sync event(s)`);

    // cleanup sub-agent
    await session.send("agents.delete", { agentId: subId });
  });
} catch (err) {
  console.error("E2E run failed:", err.message);
  check("run completed without error", false, err.message);
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  const del = await fetch(`${API}/api/sessions/${SID}`, { method: "DELETE", headers: apiHeaders });
  console.log("test session deleted:", del.status);
  rmSync(HOME_DIR, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
