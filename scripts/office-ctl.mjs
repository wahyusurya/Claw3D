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
 *   files get <agentId> <FILE>       Print an agent file (SOUL.md, AGENTS.md, IDENTITY.md,
 *                                    USER.md, TOOLS.md, MEMORY.md, HEARTBEAT.md).
 *   files set <agentId> <FILE> [--from <path>] [<text...>]
 *   memory add <agentId> <note...>   Append a dated note to the agent's MEMORY.md (capped).
 *   meeting start <topic> <agentId...>   Start the office meeting (agents gather in 3D).
 *   meeting end                      Complete the current office meeting.
 *   project get                      Show the active project (scopes GitHub review + Kanban).
 *   project set <owner/repo>         Set the project the team is working on.
 *   project clear                    No active project (review + Kanban hidden).
 *
 * Exit codes: 0 ok, 1 error, 2 aborted/cancelled.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT_FILES = ["SOUL.md", "AGENTS.md", "IDENTITY.md", "USER.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"];
const MEMORY_MAX_CHARS = 4000;

function parseArgs(argv) {
  const opts = { url: "ws://127.0.0.1:18789", timeout: 600_000, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") opts.url = argv[++i];
    else if (a === "--timeout") opts.timeout = Math.max(1, Number(argv[++i]) || 600) * 1000;
    else if (a === "--name") opts.name = argv[++i];
    else if (a === "--role") opts.role = argv[++i];
    else if (a === "--instructions") opts.instructions = argv[++i];
    else if (a === "--from") opts.from = argv[++i];
    else if (a === "--full-tools") opts.fullTools = true;
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
    // Events are broadcast to every client (e.g. live sync); only this agent's session counts.
    if (p.sessionKey && p.sessionKey !== `agent:${sub}:main`) return;
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

/** Read KEY=value from a dotenv file in the Claw3D checkout (empty string if missing). */
function readDotenv(fileName, key) {
  try {
    const line = fs.readFileSync(path.join(REPO_ROOT, fileName), "utf8")
      .split("\n").reverse().find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : "";
  } catch {
    return "";
  }
}

/** Call the Studio HTTP API (behind its access gate) using the deployment's own settings. */
async function studioFetch(apiPath, method, body) {
  const host = readDotenv(".env", "CLAW3D_HOST") || "127.0.0.1";
  const port = readDotenv(".env", "CLAW3D_PORT") || "3005";
  const token = readDotenv(".env.docker", "STUDIO_ACCESS_TOKEN");
  const response = await fetch(`http://${host}:${port}${apiPath}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: `studio_access=${token}` },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `studio ${apiPath} HTTP ${response.status}`);
  return data;
}

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
          fullTools: opts.fullTools === true,
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
        if (opts.fullTools) params.fullTools = true;
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
      // "[Team]" marks agent-to-agent briefs so the office doesn't read them as character commands.
      await send("chat.send", { sessionKey: `agent:${agentId}:main`, message: `[Team] ${message}` });
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
    } else if (command === "files") {
      const [agentId, fileName, ...textParts] = rest;
      if (!agentId || !AGENT_FILES.includes(fileName)) fail(`files ${sub} requires <agentId> <${AGENT_FILES.join("|")}>`);
      if (sub === "get") {
        const res = await send("agents.files.get", { agentId, name: fileName });
        console.log(res.file?.content ?? "");
        finish(0);
      } else if (sub === "set") {
        const content = opts.from ? fs.readFileSync(opts.from, "utf8") : textParts.join(" ");
        await send("agents.files.set", { agentId, name: fileName, content });
        console.log(`ok: ${agentId}/${fileName} (${content.length} chars)`);
        finish(0);
      } else {
        fail("files subcommand must be get|set");
      }
    } else if (command === "memory") {
      const agentId = rest[0];
      const note = rest.slice(1).join(" ").replace(/\s+/g, " ").trim();
      if (sub !== "add" || !agentId || !note) fail("memory add requires <agentId> <note...>");
      const res = await send("agents.files.get", { agentId, name: "MEMORY.md" });
      const current = res.file?.content?.trim() || "# MEMORY.md - What I remember";
      const [header, ...entries] = current.split("\n");
      entries.push(`- ${new Date().toISOString().slice(0, 10)}: ${note}`);
      // Keep the header and the newest entries within the cap (oldest notes drop off first).
      while (entries.length > 1 && [header, ...entries].join("\n").length > MEMORY_MAX_CHARS) entries.shift();
      await send("agents.files.set", { agentId, name: "MEMORY.md", content: `${[header, ...entries].join("\n")}\n` });
      console.log(`ok: remembered for ${agentId}`);
      finish(0);
    } else if (command === "meeting") {
      if (sub === "start") {
        const [topic, ...agentIds] = rest;
        if (!topic || agentIds.length === 0) fail("meeting start requires <topic> <agentId...>");
        const listed = (await send("agents.list")).agents ?? [];
        const agents = agentIds.map((agentId) => ({
          agentId,
          name: listed.find((a) => a.id === agentId)?.name ?? agentId,
          lastUserMessage: topic,
        }));
        const res = await studioFetch("/api/office/standup/run", "POST", {
          gatewayUrl: "ws://localhost:18789", trigger: "manual", agents,
        });
        console.log(`meeting ${res.meeting?.phase ?? "started"}: ${agents.map((a) => a.name).join(", ")}`);
        finish(0);
      } else if (sub === "end") {
        await studioFetch("/api/office/standup/meeting", "PUT", { action: "complete" });
        console.log("meeting completed");
        finish(0);
      } else {
        fail("meeting subcommand must be start|end");
      }
    } else if (command === "project") {
      if (sub === "get") {
        const res = await studioFetch("/api/office/project", "GET");
        console.log(res.project ?? "(none)");
      } else if (sub === "set") {
        if (!rest[0]) fail("project set requires <owner/repo>");
        const res = await studioFetch("/api/office/project", "PUT", { project: rest[0] });
        console.log(`active project: ${res.project}`);
      } else if (sub === "clear") {
        await studioFetch("/api/office/project", "PUT", { project: null });
        console.log("active project cleared");
      } else {
        fail("project subcommand must be get|set|clear");
      }
      finish(0);
    } else {
      fail(`unknown command: ${command}`);
    }
  } catch (err) {
    fail(err.message);
  }
}
