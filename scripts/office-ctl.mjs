#!/usr/bin/env node
/**
 * office-ctl — Claw3D office team control for the Secretary agent.
 *
 * Talks to the hermes-adapter WebSocket (default ws://127.0.0.1:18789) so the
 * Secretary (Hermes agent) can manage and delegate to the office sub-agents
 * shown as 3D characters. Sub-agent replies come back to the Secretary only —
 * they never appear in Telegram directly.
 *
 * Usage:
 *   node scripts/office-ctl.mjs [--url ws://127.0.0.1:18789] [--timeout 600] <command>
 *
 * Commands:
 *   agents list
 *   agents create --name <name> [--role <role>] [--instructions <text>]
 *   agents update <agentId> [--name <name>] [--role <role>] [--instructions <text>]
 *   agents delete <agentId>
 *   chat <agentId> <message...>      Send a task; waits for the final reply.
 *   history <agentId>                Show the agent's chat history.
 *
 * Exit codes: 0 ok, 1 error, 2 aborted/cancelled.
 */

import WebSocket from "ws";

function parseArgs(argv) {
  const opts = { url: "ws://127.0.0.1:18789", timeout: 600_000, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") opts.url = argv[++i];
    else if (a === "--timeout") opts.timeout = Math.max(1, Number(argv[++i]) || 600) * 1000;
    else if (a === "--name") opts.name = argv[++i];
    else if (a === "--role") opts.role = argv[++i];
    else if (a === "--instructions") opts.instructions = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

function fail(msg) {
  console.error(`office-ctl: ${msg}`);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
const [command, sub, ...rest] = opts.positional;
if (!command) fail("missing command (agents|chat|history)");

const ws = new WebSocket(opts.url);
let nextId = 1;
const pending = new Map();
let chatRunId = null;
let chatDone = false;

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, opts.timeout);
  });
}

function finish(code) {
  ws.close();
  process.exit(code);
}

ws.on("error", (err) => fail(`websocket: ${err.message}`));

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "req", id: String(nextId++), method: "connect", params: {} }));
  // connect resolves through the pending map like any other call
  pending.set(String(nextId - 1), {
    resolve: () => { void run(); },
    reject: (err) => fail(err.message),
  });
});

ws.on("message", (raw) => {
  let frame;
  try { frame = JSON.parse(raw.toString("utf8")); } catch { return; }
  if (frame.type === "res") {
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.ok) entry.resolve(frame.payload);
    else entry.reject(new Error(frame.error?.message || frame.error?.code || "request failed"));
  } else if (frame.type === "event" && frame.event === "chat" && command === "chat") {
    const p = frame.payload || {};
    if (!chatRunId && p.runId) chatRunId = p.runId;
    if (p.runId && chatRunId && p.runId !== chatRunId) return;
    if (p.state === "final") {
      chatDone = true;
      console.log(p.message?.content ?? "");
      finish(0);
    } else if (p.state === "error") {
      chatDone = true;
      console.error(p.errorMessage || "chat error");
      finish(1);
    } else if (p.state === "aborted") {
      chatDone = true;
      console.error("aborted");
      finish(2);
    }
  }
});

async function run() {
  try {
    if (command === "agents") {
      if (sub === "list") {
        const res = await send("agents.list");
        console.log(JSON.stringify(res.agents ?? res, null, 2));
        finish(0);
      } else if (sub === "create") {
        if (!opts.name) fail("agents create requires --name");
        const res = await send("agents.create", {
          name: opts.name,
          role: opts.role ?? "",
          systemPrompt: opts.instructions ?? "",
        });
        console.log(JSON.stringify(res, null, 2));
        finish(0);
      } else if (sub === "update") {
        const agentId = rest[0];
        if (!agentId) fail("agents update requires <agentId>");
        const params = { agentId };
        if (opts.name) params.name = opts.name;
        if (opts.role) params.role = opts.role;
        if (opts.instructions) params.systemPrompt = opts.instructions;
        const res = await send("agents.update", params);
        console.log(JSON.stringify(res, null, 2));
        finish(0);
      } else if (sub === "delete") {
        const agentId = rest[0];
        if (!agentId) fail("agents delete requires <agentId>");
        const res = await send("agents.delete", { agentId });
        console.log(JSON.stringify(res, null, 2));
        finish(0);
      } else {
        fail("agents subcommand must be list|create|update|delete");
      }
    } else if (command === "chat") {
      const agentId = sub;
      const message = rest.join(" ").trim();
      if (!agentId || !message) fail("chat requires <agentId> <message>");
      await send("chat.send", { sessionKey: `agent:${agentId}:main`, message });
      // reply arrives as chat events; give the server-side turn time to finish
      setTimeout(() => {
        if (!chatDone) {
          console.error("timed out waiting for the agent reply");
          finish(1);
        }
      }, opts.timeout);
    } else if (command === "history") {
      const agentId = sub;
      if (!agentId) fail("history requires <agentId>");
      const res = await send("chat.history", { sessionKey: `agent:${agentId}:main` });
      console.log(JSON.stringify(res.messages ?? [], null, 2));
      finish(0);
    } else {
      fail(`unknown command: ${command}`);
    }
  } catch (err) {
    fail(err.message);
  }
}
