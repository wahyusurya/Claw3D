"use strict";

/**
 * Hermes Gateway Adapter — with multi-agent orchestration
 *
 * The main Hermes agent acts as an orchestrator and can:
 *   - spawn_agent(name, role, instructions, wipe, continuity, boundaries)
 *   - delegate_task(agent_id, message)
 *   - list_team()
 *   - configure_agent(agent_id, ...)
 *   - dismiss_agent(agent_id)
 *
 * Sub-agents appear as 3D characters in the office, each with their own
 * conversation history, system prompt, and settings.
 *
 * Environment variables:
 *   HERMES_API_URL        Hermes HTTP API base URL   (default: http://localhost:8642)
 *   HERMES_API_KEY        Bearer token for Hermes     (default: empty)
 *   HERMES_ADAPTER_PORT   WebSocket port              (default: 18789)
 *   HERMES_MODEL          Model identifier            (default: hermes)
 *   HERMES_AGENT_NAME     Display name in Claw3D UI   (default: Hermes)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

function loadDotenvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadRuntimeEnv() {
  const cwd = process.cwd();
  loadDotenvFile(path.join(cwd, ".env.local"));
  loadDotenvFile(path.join(cwd, ".env"));
}

loadRuntimeEnv();

const HERMES_API_URL = (process.env.HERMES_API_URL || "http://localhost:8642").replace(/\/$/, "");
const HERMES_API_KEY = process.env.HERMES_API_KEY || "";
const ADAPTER_PORT = parseInt(process.env.HERMES_ADAPTER_PORT || "18789", 10);
const HERMES_MODEL = process.env.HERMES_MODEL || "hermes";
const HERMES_AGENT_NAME = process.env.HERMES_AGENT_NAME || "Hermes";
const HOME = process.env.HOME || "/tmp";
// Hermes profile skills dir as seen by this process (read-only mount) and as the host path
// Hermes itself uses. Reported via skills.status so the Studio skill UI has a workspace.
const HERMES_SKILLS_DIR = process.env.HERMES_SKILLS_DIR || "";
const HERMES_SKILLS_HOST_DIR = process.env.HERMES_SKILLS_HOST_DIR || HERMES_SKILLS_DIR || `${HOME}/.hermes/skills`;

const AGENT_ID = "hermes";
const MAIN_KEY = "main";
const MAIN_SESSION_KEY = `agent:${AGENT_ID}:${MAIN_KEY}`;
const CONFIG_PATH = `${HOME}/.hermes/config.json`;
const MAX_TOOL_ROUNDS = 8;

// ---------------------------------------------------------------------------
// Orchestrator system prompt
// ---------------------------------------------------------------------------

const ORCHESTRATOR_SYSTEM_PROMPT = `You are ${HERMES_AGENT_NAME}, an AI orchestrator managing a team of sub-agents in a virtual 3D office.

You have tools to build and manage your team autonomously:

- **spawn_agent**: Create a new specialist agent with a name, role, instructions, and settings (wipe/continuity/boundaries).
- **delegate_task**: Send a task to a specific agent and receive their response.
- **list_team**: See all current team members and their IDs, names, and roles.
- **configure_agent**: Update an agent's name, role/title, instructions, or settings.
- **dismiss_agent**: Remove an agent from the team.
- **read_agent_context**: Read the recent conversation history of another agent to understand what they are currently working on, what they have already done, or what their status is. Use this for coordination — before delegating a task, check if the agent already has relevant context.

When given a goal:
1. Analyse what specialist roles are needed.
2. spawn_agent for each specialist.
3. delegate_task to assign work and coordinate.
4. Use read_agent_context to check what an agent has done or is doing before re-delegating.
5. Synthesise results into a final answer for the user.

Each spawned agent will appear as an animated character in the 3D office — walking when active, standing when idle.
Be concise in your responses to the user; do the heavy lifting via tool calls.`;

// ---------------------------------------------------------------------------
// Team management tools definition (OpenAI tool-calling format)
// ---------------------------------------------------------------------------

const TEAM_TOOLS = [
  {
    type: "function",
    function: {
      name: "spawn_agent",
      description: "Create a new sub-agent team member. Returns the agent's ID.",
      parameters: {
        type: "object",
        required: ["name", "role"],
        properties: {
          name: { type: "string", description: "Display name, e.g. 'Backend Dev'" },
          role: { type: "string", description: "Short role description, e.g. 'Python backend specialist'" },
          instructions: { type: "string", description: "System prompt / instructions for this agent" },
          wipe: { type: "boolean", description: "Clear history before each run (stateless). Default false." },
          continuity: { type: "boolean", description: "Maintain full conversation history. Default true." },
          boundaries: { type: "string", description: "Hard constraints on what this agent may do" },
          model: { type: "string", description: "Model to use. Defaults to hermes." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_task",
      description: "Send a task or question to a specific team member and get their response.",
      parameters: {
        type: "object",
        required: ["agent_id", "message"],
        properties: {
          agent_id: { type: "string", description: "ID returned by spawn_agent" },
          message: { type: "string", description: "The task, question, or instructions to send" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_team",
      description: "List all current team members with their IDs, names, and roles.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "configure_agent",
      description: "Update an existing agent's name, role/title, instructions, or settings.",
      parameters: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "string" },
          name: { type: "string" },
          role: { type: "string", description: "Short role or title shown as subtitle below the agent name in the office (e.g. 'Marketing Chef', 'Code Reviewer')." },
          instructions: { type: "string" },
          wipe: { type: "boolean" },
          continuity: { type: "boolean" },
          boundaries: { type: "string" },
          model: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dismiss_agent",
      description: "Remove an agent from the team.",
      parameters: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_agent_context",
      description: "Read the recent conversation history of another agent to understand what they are working on, what they have already done, or what their current status is. Useful for coordination and avoiding duplicate work.",
      parameters: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "string", description: "ID of the agent whose context you want to read" },
          last_n: { type: "number", description: "How many recent messages to return (default 10, max 40)" },
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** @type {Map<string, Array<{role: string, content: string}>>} */
const conversationHistory = new Map();

/** @type {Map<string, {model?: string, thinkingLevel?: string}>} */
const sessionSettings = new Map();

/** @type {Map<string, string>} agentId/filename → content */
const agentFiles = new Map();

/** @type {Map<string, {runId: string, sessionKey: string, agentId: string, abort: () => void}>} runId → abort handle */
const activeRuns = new Map();

/** @type {Map<string, object>} jobId → CronJobSummary */
const cronJobs = new Map();

/**
 * @type {Map<string, {
 *   id: string, name: string, workspace: string,
 *   role?: string, systemPrompt?: string,
 *   settings: { wipe: boolean, continuity: boolean, model: string, boundaries?: string }
 * }>}
 */
const agentRegistry = new Map([
  [AGENT_ID, {
    id: AGENT_ID,
    name: HERMES_AGENT_NAME,
    workspace: `${HOME}/.hermes/workspace-hermes`,
    role: "Orchestrator",
    systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    settings: { wipe: false, continuity: true, model: HERMES_MODEL },
  }],
]);

// Set of all active sendEvent functions (one per connected WS client)
/** @type {Set<(frame: object) => void>} */
const activeSendEventFns = new Set();

// ---------------------------------------------------------------------------
// Disk persistence for conversation history
// ---------------------------------------------------------------------------

const HISTORY_FILE = path.join(HOME, ".hermes", "clawd3d-history.json");
let persistDebounceTimer = null;

function loadHistoryFromDisk() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        for (const [key, messages] of Object.entries(data)) {
          if (Array.isArray(messages)) conversationHistory.set(key, messages);
        }
        console.log(`[hermes-adapter] Loaded history for ${Object.keys(data).length} session(s).`);
      }
    }
  } catch (err) {
    console.warn("[hermes-adapter] Could not load history:", sanitizeErrorMessage(err));
  }
}

function saveHistoryToDisk() {
  if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
  persistDebounceTimer = setTimeout(() => {
    try {
      const data = {};
      for (const [key, messages] of conversationHistory.entries()) {
        if (messages.length > 0) data[key] = messages;
      }
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.warn("[hermes-adapter] Could not save history:", sanitizeErrorMessage(err));
    }
  }, 500);
}

// ---------------------------------------------------------------------------
// Disk persistence for the agent roster (created/renamed agents + their files).
// Without this, every adapter restart dropped user-created agents.
// ---------------------------------------------------------------------------

const AGENTS_FILE = path.join(HOME, ".hermes", "claw3d-agents.json");
let agentsPersistTimer = null;

function loadAgentsFromDisk() {
  try {
    if (!fs.existsSync(AGENTS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
    for (const saved of Array.isArray(data?.agents) ? data.agents : []) {
      if (!saved || typeof saved.id !== "string" || !saved.id) continue;
      if (saved.id === AGENT_ID) {
        // Keep the orchestrator's built-in prompt/tools from code; restore user-facing fields only.
        const main = agentRegistry.get(AGENT_ID);
        if (typeof saved.name === "string" && saved.name) main.name = saved.name;
        if (typeof saved.role === "string") main.role = saved.role;
        if (saved.settings && typeof saved.settings === "object") main.settings = { ...main.settings, ...saved.settings };
        continue;
      }
      agentRegistry.set(saved.id, saved);
    }
    for (const [key, content] of Object.entries(data?.files ?? {})) {
      if (typeof content === "string") agentFiles.set(key, content);
    }
    console.log(`[hermes-adapter] Loaded ${agentRegistry.size} agent(s) from disk.`);
  } catch (err) {
    console.warn("[hermes-adapter] Could not load agents:", sanitizeErrorMessage(err));
  }
}

function saveAgentsToDisk() {
  if (agentsPersistTimer) clearTimeout(agentsPersistTimer);
  agentsPersistTimer = setTimeout(() => {
    try {
      const data = { agents: [...agentRegistry.values()], files: Object.fromEntries(agentFiles) };
      fs.mkdirSync(path.dirname(AGENTS_FILE), { recursive: true });
      fs.writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.warn("[hermes-adapter] Could not save agents:", sanitizeErrorMessage(err));
    }
  }, 300);
}

function getHistory(sessionKey) {
  if (!conversationHistory.has(sessionKey)) conversationHistory.set(sessionKey, []);
  return conversationHistory.get(sessionKey);
}

function clearHistory(sessionKey) {
  conversationHistory.delete(sessionKey);
  saveHistoryToDisk();
}

function randomId() {
  return require("crypto").randomBytes(8).toString("hex");
}

function redactSecrets(value) {
  if (typeof value !== "string" || !value) return value;
  let redacted = value;
  if (HERMES_API_KEY) {
    redacted = redacted.split(HERMES_API_KEY).join("[REDACTED]");
  }
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(/\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
  return redacted;
}

// ---------------------------------------------------------------------------
// Hermes HTTP API helpers
// ---------------------------------------------------------------------------

function hermesPost(path, body) {
  return new Promise((resolve, reject) => {
    const urlStr = HERMES_API_URL + path;
    let url;
    try { url = new URL(urlStr); } catch { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
    const transport = url.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) };
    if (HERMES_API_KEY) headers["Authorization"] = `Bearer ${HERMES_API_KEY}`;
    const req = transport.request(
      { hostname: url.hostname, port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""), method: "POST", headers },
      resolve
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function hermesGet(path) {
  return new Promise((resolve, reject) => {
    const urlStr = HERMES_API_URL + path;
    let url;
    try { url = new URL(urlStr); } catch { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
    const transport = url.protocol === "https:" ? https : http;
    const headers = {};
    if (HERMES_API_KEY) headers["Authorization"] = `Bearer ${HERMES_API_KEY}`;
    const req = transport.request(
      { hostname: url.hostname, port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""), method: "GET", headers },
      resolve
    );
    req.on("error", reject);
    req.end();
  });
}

async function readJsonBody(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Shared session — the Secretary's conversation lives in a real Hermes session
// so the Claw3D office chat and the Telegram bot share ONE thread.
//
// Resolution order for the shared session id:
//   1. CLAW3D_SHARED_SESSION_ID env (explicit pin)
//   2. pinned state file (~/.hermes/claw3d-shared-session.json) — e.g. after an
//      office-side "new chat", which pins a fresh adapter-owned session
//   3. newest Telegram session of this profile (office mirrors the DM)
//   4. create a fresh adapter-owned session and pin it
//
// Sub-agents never use the shared session — their chats stay local so they
// cannot reply in Telegram. Opt-in: CLAW3D_SHARED_SESSION=on (default off = local history).
// ---------------------------------------------------------------------------

const SHARED_SESSION_ENABLED = (process.env.CLAW3D_SHARED_SESSION || "off") === "on";
// Model for adapter-created shared sessions. Hermes' session API otherwise falls back to the
// API server's own model name, which may not map to a configured provider — set this to the
// profile's real model (e.g. a 9router/custom model name).
const SHARED_SESSION_MODEL = (process.env.CLAW3D_SHARED_SESSION_MODEL || "").trim();
const sharedSessionCreateBody = (title) => (SHARED_SESSION_MODEL ? { title, model: SHARED_SESSION_MODEL } : { title });
const SHARED_SESSION_FILE = path.join(HOME, ".hermes", "claw3d-shared-session.json");

function readSharedSessionState() {
  try {
    const data = JSON.parse(fs.readFileSync(SHARED_SESSION_FILE, "utf8"));
    if (data && typeof data === "object") return data;
  } catch { /* no state yet */ }
  return {};
}

function writeSharedSessionState(state) {
  try {
    fs.mkdirSync(path.dirname(SHARED_SESSION_FILE), { recursive: true });
    fs.writeFileSync(SHARED_SESSION_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn("[hermes-adapter] Could not save shared session state:", sanitizeErrorMessage(err));
  }
}

function hermesDelete(pathName) {
  return new Promise((resolve, reject) => {
    const urlStr = HERMES_API_URL + pathName;
    let url;
    try { url = new URL(urlStr); } catch { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
    const transport = url.protocol === "https:" ? https : http;
    const headers = {};
    if (HERMES_API_KEY) headers["Authorization"] = `Bearer ${HERMES_API_KEY}`;
    const req = transport.request(
      { hostname: url.hostname, port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""), method: "DELETE", headers },
      resolve
    );
    req.on("error", reject);
    req.end();
  });
}

function sharedSessionTitle() {
  return `Secretary office chat ${new Date().toISOString().slice(0, 19).replace("T", " ")} ${randomId().slice(0, 4)}`;
}

let sharedSessionMemo = { id: "", at: 0 };

async function resolveSharedSessionId() {
  const envId = (process.env.CLAW3D_SHARED_SESSION_ID || "").trim();
  if (envId) return envId;
  const now = Date.now();
  if (sharedSessionMemo.id && now - sharedSessionMemo.at < 10_000) return sharedSessionMemo.id;

  const state = readSharedSessionState();
  if (state.id && state.pinned) {
    sharedSessionMemo = { id: state.id, at: now };
    return state.id;
  }

  // Follow the newest Telegram session so office chat == Telegram DM.
  try {
    const res = await hermesGet("/api/sessions?source=telegram&limit=20");
    if (res.statusCode < 400) {
      const payload = await readJsonBody(res);
      const sessions = Array.isArray(payload?.data) ? payload.data : [];
      const newest = sessions
        .filter((s) => typeof s?.id === "string" && s.id)
        .sort((a, b) => ((b.last_active || b.started_at || 0) - (a.last_active || a.started_at || 0)))[0];
      if (newest) {
        sharedSessionMemo = { id: newest.id, at: now };
        return newest.id;
      }
    } else {
      res.resume();
    }
  } catch (err) {
    console.warn("[hermes-adapter] Shared-session telegram lookup failed:", sanitizeErrorMessage(err));
  }

  if (state.id) {
    sharedSessionMemo = { id: state.id, at: now };
    return state.id;
  }

  const title = sharedSessionTitle();
  const res = await hermesPost("/api/sessions", sharedSessionCreateBody(title));
  const payload = await readJsonBody(res);
  const created = payload?.session?.id;
  if (!created) throw new Error(extractOpenAiStyleError(payload, "Could not create shared session"));
  writeSharedSessionState({ id: created, pinned: true, owned: true, title });
  sharedSessionMemo = { id: created, at: now };
  console.log(`[hermes-adapter] Created shared session ${created}`);
  return created;
}

async function fetchSharedMessages(sessionId) {
  const res = await hermesGet(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
  if (res.statusCode >= 400) {
    res.resume();
    throw new Error(`Hermes sessions API HTTP ${res.statusCode}`);
  }
  const payload = await readJsonBody(res);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
}

async function getSharedHistory() {
  return fetchSharedMessages(await resolveSharedSessionId());
}

// Per-agent Hermes session for full-tools office sub-agents (created lazily, id
// persisted on the agent roster entry). Never resolves to a Telegram session.
async function ensureAgentSession(agentId) {
  const agent = agentRegistry.get(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  if (agent.sessionApiId) return agent.sessionApiId;
  const slug = (agent.name || agentId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const title = `office-${slug || "agent"}-${Date.now().toString(36)}`;
  const res = await hermesPost("/api/sessions", sharedSessionCreateBody(title));
  const payload = await readJsonBody(res);
  const created = payload?.session?.id;
  if (!created) throw new Error(extractOpenAiStyleError(payload, "Could not create agent session"));
  agent.sessionApiId = created;
  saveAgentsToDisk();
  console.log(`[hermes-adapter] Agent ${agentId} session: ${created}`);
  return created;
}

// A "NEW REQUEST" brief starts a new task: the whole full-tools team gets fresh Hermes sessions so
// earlier tasks (often other repos) don't leak into it. Follow-ups (APPROVED PLAN/PUSH, teammate
// asks) keep the session. Old sessions stay in Hermes; durable knowledge lives in MEMORY.md.
const NEW_REQUEST_RE = /^(?:\[Team\]\s*)?NEW REQUEST\b/;
function resetTeamSessionsOnNewRequest(message) {
  if (!NEW_REQUEST_RE.test(String(message || "").trimStart())) return;
  const reset = [...agentRegistry.values()].filter((a) => a.fullTools && a.sessionApiId);
  for (const a of reset) a.sessionApiId = null;
  if (reset.length === 0) return;
  saveAgentsToDisk();
  console.log(`[hermes-adapter] NEW REQUEST: fresh sessions for ${reset.map((a) => a.id).join(", ")}`);
}

// Transcript for any agent:* session key — shared (Secretary), per-agent
// (full-tools workers), or the local text loop (lightweight sub-agents).
async function historyForKey(key) {
  const agentId = key.startsWith("agent:") ? key.split(":")[1] : AGENT_ID;
  if (SHARED_SESSION_ENABLED && agentId === AGENT_ID) return getSharedHistory();
  const agent = agentRegistry.get(agentId);
  if (SHARED_SESSION_ENABLED && agent?.fullTools && agent.sessionApiId) {
    const messages = await fetchSharedMessages(agent.sessionApiId);
    return messages.map((m) => (m.role === "user" ? { ...m, content: stripAgentPersona(m.content) } : m));
  }
  return getHistory(key);
}

// Full-tools turns are sent as "<agent definition>\n\n---\n\n<message>". Show only the message:
// the definition is not what the user/teammate said, and the office parses the last user
// message for character commands ("skill", "message", "meeting"...).
const PERSONA_SEPARATOR = "\n\n---\n\n";
function stripAgentPersona(content) {
  const text = String(content || "");
  if (!/^You are .+\(agent id: [^)]+\)/.test(text)) return text;
  const index = text.lastIndexOf(PERSONA_SEPARATOR);
  return index >= 0 ? text.slice(index + PERSONA_SEPARATOR.length) : text;
}

/**
 * Run one Secretary turn inside the shared Hermes session (SSE).
 * emitDelta receives ACCUMULATED text (same convention as streamOneTurn).
 * @returns {{ text: string, cancelled: boolean }}
 */
async function runSharedSessionTurn({ sessionId: forcedSessionId, userMessage, emitDelta, abortCheck }) {
  const sessionId = forcedSessionId || await resolveSharedSessionId();
  const res = await hermesPost(`/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, { input: userMessage });
  if (res.statusCode >= 400) {
    res.resume();
    throw new Error(`Hermes session chat HTTP ${res.statusCode}`);
  }

  let runId = "";
  let finalText = "";
  let acc = "";
  let cancelled = false;
  let failedMessage = "";
  let eventName = "";
  let buffer = "";

  await new Promise((resolve, reject) => {
    res.on("data", (chunk) => {
      if (abortCheck && abortCheck()) {
        res.destroy();
        if (runId) hermesPost(`/v1/runs/${runId}/stop`, {}).catch(() => {});
        cancelled = true;
        return;
      }
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line || line.startsWith(":")) continue; // SSE keepalive comments
        if (line.startsWith("event: ")) { eventName = line.slice(7).trim(); continue; }
        if (!line.startsWith("data: ")) continue;
        let data;
        try { data = JSON.parse(line.slice(6)); } catch { continue; }
        if (data?.run_id) runId = data.run_id;
        if (eventName === "assistant.delta") {
          const piece = typeof data.delta === "string" ? data.delta
            : typeof data.text === "string" ? data.text
            : typeof data.content === "string" ? data.content : "";
          if (piece) {
            acc += piece;
            if (emitDelta) emitDelta(acc);
          }
        } else if (eventName === "tool.started") {
          const toolName = data.name || data.tool_name || data.tool || "tool";
          if (emitDelta) emitDelta((acc ? acc + "\n\n" : "") + `Executing: ${toolName}…`);
        } else if (eventName === "assistant.completed") {
          if (typeof data.content === "string" && data.content) finalText = data.content;
        } else if (eventName === "run.failed") {
          failedMessage = typeof data.error === "string" ? data.error
            : typeof data.message === "string" ? data.message
            : "Shared session run failed";
        } else if (eventName === "run.cancelled") {
          cancelled = true;
        }
      }
    });
    res.on("end", resolve);
    res.on("error", reject);
  });

  if (cancelled) return { text: finalText || acc, cancelled: true };
  if (failedMessage) throw new Error(failedMessage);
  return { text: finalText || acc, cancelled: false };
}

function sanitizeErrorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return redactSecrets(error);
  return redactSecrets(error.message || String(error));
}

function extractOpenAiStyleError(payload, fallbackMessage) {
  if (payload && typeof payload === "object") {
    const message =
      typeof payload?.error?.message === "string"
        ? payload.error.message.trim()
        : "";
    if (message) return message;
  }
  return fallbackMessage;
}

let cachedHermesModels = null;
let cachedHermesModelsAt = 0;

async function fetchHermesModels() {
  const now = Date.now();
  if (cachedHermesModels && now - cachedHermesModelsAt < 30_000) {
    return cachedHermesModels;
  }
  const res = await hermesGet("/v1/models");
  if (res.statusCode >= 400) {
    res.resume();
    throw new Error(`Hermes models API HTTP ${res.statusCode}`);
  }
  const payload = await readJsonBody(res);
  const models = Array.isArray(payload?.data)
    ? payload.data
        .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
        .filter(Boolean)
    : [];
  cachedHermesModels = models;
  cachedHermesModelsAt = now;
  return models;
}

async function resolveHermesModel(requestedModel) {
  const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const normalized = trimmed.includes("/") ? trimmed.split("/").pop().trim() : trimmed;
  try {
    const models = await fetchHermesModels();
    if (models.length === 0) {
      return normalized || trimmed || HERMES_MODEL;
    }
    const candidates = [trimmed, normalized, HERMES_MODEL]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    for (const candidate of candidates) {
      const exact = models.find((modelId) => modelId === candidate);
      if (exact) return exact;
    }
    for (const candidate of candidates) {
      const suffix = models.find((modelId) => modelId.endsWith(`/${candidate}`));
      if (suffix) return suffix;
    }
    return models[0];
  } catch {
    return normalized || trimmed || HERMES_MODEL;
  }
}

async function completeOneTurn(messages, model, tools) {
  const resolvedModel = await resolveHermesModel(model);
  const body = { model: resolvedModel, messages, stream: false };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const res = await hermesPost("/v1/chat/completions", body);
  const payload = await readJsonBody(res);
  if (res.statusCode >= 400) {
    throw new Error(
      extractOpenAiStyleError(payload, `Hermes API HTTP ${res.statusCode}`)
    );
  }
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = choice?.message || {};
  const textContent =
    typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("")
        : "";
  const finishReason =
    typeof choice?.finish_reason === "string" && choice.finish_reason
      ? choice.finish_reason
      : "stop";
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map((tc) => {
        let args = {};
        const rawArgs = tc?.function?.arguments;
        if (typeof rawArgs === "string" && rawArgs.trim()) {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = { _raw: rawArgs };
          }
        }
        return {
          id: typeof tc?.id === "string" ? tc.id : randomId(),
          name: typeof tc?.function?.name === "string" ? tc.function.name : "",
          args,
        };
      })
    : [];
  return { textContent, toolCalls, finishReason, resolvedModel };
}

// ---------------------------------------------------------------------------
// SSE streaming — handles both text deltas and tool calls
// ---------------------------------------------------------------------------

/**
 * Stream one LLM turn.
 * @returns {{ textContent: string, toolCalls: Array<{id,name,args}>, finishReason: string }}
 */
async function streamOneTurn(messages, model, tools, onTextDelta, abortCheck) {
  const body = { model, messages, stream: true };
  if (tools && tools.length > 0) { body.tools = tools; body.tool_choice = "auto"; }

  const resolvedModel = await resolveHermesModel(model);
  body.model = resolvedModel;
  const res = await hermesPost("/v1/chat/completions", body);
  if (res.statusCode >= 400) {
    res.resume();
    throw new Error(`Hermes API HTTP ${res.statusCode}`);
  }

  let textContent = "";
  let finishReason = "stop";
  /** @type {Record<number, {id: string, name: string, argsStr: string}>} */
  const toolCallAccum = {};
  let buffer = "";

  await new Promise((resolve, reject) => {
    res.on("data", (chunk) => {
      if (abortCheck && abortCheck()) { res.destroy(); return; }
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(trimmed.slice(6));
          const choice = data?.choices?.[0];
          if (!choice) continue;
          if (typeof choice.finish_reason === "string" && choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
          const delta = choice.delta || {};
          // Text content
          if (typeof delta.content === "string" && delta.content) {
            textContent += delta.content;
            if (onTextDelta) onTextDelta(textContent);
          }
          // Tool call accumulation
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === "number" ? tc.index : 0;
              if (!toolCallAccum[idx]) toolCallAccum[idx] = { id: "", name: "", argsStr: "" };
              if (tc.id) toolCallAccum[idx].id = tc.id;
              if (tc.function?.name) toolCallAccum[idx].name += tc.function.name;
              if (tc.function?.arguments) toolCallAccum[idx].argsStr += tc.function.arguments;
            }
          }
        } catch { /* ignore malformed */ }
      }
    });
    res.on("end", resolve);
    res.on("error", reject);
  });

  const toolCalls = Object.values(toolCallAccum).map((tc) => {
    let args = {};
    try { args = JSON.parse(tc.argsStr); } catch { args = { _raw: tc.argsStr }; }
    return { id: tc.id, name: tc.name, args };
  });

  if (!textContent.trim() && toolCalls.length === 0 && finishReason === "stop") {
    const fallback = await completeOneTurn(messages, resolvedModel, tools);
    return {
      textContent: fallback.textContent,
      toolCalls: fallback.toolCalls,
      finishReason: fallback.finishReason,
    };
  }

  return { textContent, toolCalls, finishReason };
}

// ---------------------------------------------------------------------------
// Hermes skills -> Studio SkillStatusEntry (read-only listing of SKILL.md dirs)
// ---------------------------------------------------------------------------

function listHermesSkills() {
  if (!HERMES_SKILLS_DIR) return [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(HERMES_SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const emptyReqs = { bins: [], anyBins: [], env: [], config: [], os: [] };
  const skills = [];
  for (const dir of dirs) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(HERMES_SKILLS_DIR, dir.name, "SKILL.md"), "utf8");
    } catch {
      continue; // category folders etc. have no SKILL.md at this level
    }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    const field = (key) => {
      const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front);
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
    };
    const baseDir = path.join(HERMES_SKILLS_HOST_DIR, dir.name);
    skills.push({
      name: field("name") || dir.name,
      description: field("description"),
      source: "hermes",
      bundled: false,
      filePath: path.join(baseDir, "SKILL.md"),
      baseDir,
      skillKey: dir.name,
      always: false,
      disabled: false,
      blockedByAllowlist: false,
      eligible: true,
      requirements: emptyReqs,
      missing: emptyReqs,
      configChecks: [],
      install: [],
    });
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Broadcast a gateway event to all connected clients
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Live sync: turns made from Telegram show up in an open office.
// While an office client is connected, poll the shared transcript; when it changes
// outside an office turn and ends with an assistant reply, broadcast a chat "final"
// with no streamed trace. The office treats that as "refresh history" and pulls the
// full transcript (including the Telegram user message).
// ---------------------------------------------------------------------------

const SHARED_SYNC_INTERVAL_MS = Math.max(
  2000,
  parseInt(process.env.CLAW3D_SHARED_SYNC_MS || "4000", 10) || 4000,
);
let sharedSyncFingerprint = null; // null = take a fresh baseline on the next poll
let officeSharedTurns = 0;
let sharedSyncPolling = false;

function sharedTranscriptFingerprint(sessionId, messages) {
  const last = messages[messages.length - 1];
  return `${sessionId}|${messages.length}|${last ? `${last.role}:${last.content.length}:${last.content.slice(-64)}` : ""}`;
}

async function pollSharedSession() {
  if (!SHARED_SESSION_ENABLED || activeSendEventFns.size === 0 || officeSharedTurns > 0 || sharedSyncPolling) return;
  sharedSyncPolling = true;
  try {
    const sessionId = await resolveSharedSessionId();
    const messages = await fetchSharedMessages(sessionId);
    if (officeSharedTurns > 0) return; // an office turn started meanwhile; its own events cover it
    const fingerprint = sharedTranscriptFingerprint(sessionId, messages);
    if (sharedSyncFingerprint === null || fingerprint === sharedSyncFingerprint) {
      sharedSyncFingerprint = fingerprint;
      return;
    }
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return; // wait for the reply; re-checked next poll
    sharedSyncFingerprint = fingerprint;
    broadcastEvent({
      type: "event", event: "chat",
      payload: {
        runId: `shared-sync-${randomId()}`, sessionKey: MAIN_SESSION_KEY, state: "final",
        stopReason: "end_turn", message: { role: "assistant", content: last.content },
      },
    });
  } finally {
    sharedSyncPolling = false;
  }
}

// ---------------------------------------------------------------------------
// Heartbeats: an office agent whose HEARTBEAT.md contains an "every: <n>m|h" line gets its
// instructions sent as a chat turn on that schedule. Results are broadcast to every office
// client like a normal reply. One heartbeat runs at a time; busy agents are skipped.
// Disable all with CLAW3D_HEARTBEATS=off.
// ---------------------------------------------------------------------------

const HEARTBEATS_ENABLED = (process.env.CLAW3D_HEARTBEATS || "on") !== "off";
const HEARTBEAT_TICK_MS = 60_000;
const heartbeatLastRunAt = new Map(); // agentId -> ms
let heartbeatRunning = false;

function parseHeartbeat(text) {
  if (typeof text !== "string") return null;
  const match = /^\s*every\s*:\s*(\d+)\s*(m|min|minutes?|h|hours?)\s*$/im.exec(text);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const intervalMs = amount * (match[2].startsWith("h") ? 3_600_000 : 60_000);
  if (!Number.isFinite(intervalMs) || intervalMs < 5 * 60_000) return null; // floor: 5 minutes
  const instructions = text.replace(match[0], "").replace(/^#.*$/gm, "").trim();
  return instructions ? { intervalMs, instructions } : null;
}

async function runDueHeartbeat() {
  if (!HEARTBEATS_ENABLED || heartbeatRunning) return;
  const now = Date.now();
  for (const agent of agentRegistry.values()) {
    if (agent.id === AGENT_ID) continue;
    const heartbeat = parseHeartbeat(agentFiles.get(`${agent.id}/HEARTBEAT.md`));
    if (!heartbeat) continue;
    if (!heartbeatLastRunAt.has(agent.id)) { heartbeatLastRunAt.set(agent.id, now); continue; } // no burst on startup
    if (now - heartbeatLastRunAt.get(agent.id) < heartbeat.intervalMs) continue;
    const sessionKey = `agent:${agent.id}:${MAIN_KEY}`;
    if ([...activeRuns.values()].some((run) => run.sessionKey === sessionKey)) continue;
    heartbeatLastRunAt.set(agent.id, now);
    heartbeatRunning = true;
    const runId = `heartbeat-${agent.id}-${now}`;
    console.log(`[hermes-adapter] Heartbeat: ${agent.name} (${agent.id})`);
    try {
      await handleMethod("chat.send", {
        sessionKey, idempotencyKey: runId,
        message: `[Heartbeat ${new Date(now).toISOString()}]\n${heartbeat.instructions}`,
      }, `hb-${randomId()}`, (frame) => broadcastEvent(frame));
      // chat.send runs the turn asynchronously; wait for it so heartbeats never overlap
      const deadline = Date.now() + 15 * 60_000;
      while (activeRuns.has(runId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    } finally {
      heartbeatRunning = false;
    }
    return; // one per tick
  }
}

function broadcastEvent(frame) {
  for (const fn of activeSendEventFns) {
    try { fn(frame); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

async function execSpawnAgent(args) {
  const name = (typeof args.name === "string" ? args.name : "Agent").trim() || "Agent";
  const role = (typeof args.role === "string" ? args.role : "").trim();
  const instructions = typeof args.instructions === "string" ? args.instructions.trim() : "";
  const boundaries = typeof args.boundaries === "string" ? args.boundaries.trim() : "";
  const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : HERMES_MODEL;
  const wipe = Boolean(args.wipe);
  const continuity = args.continuity !== false;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const newId = `${slug}-${randomId().slice(0, 6)}`;

  let systemPrompt = instructions || `You are ${name}, a ${role || "specialist"} agent.`;
  if (boundaries) systemPrompt += `\n\nBoundaries: ${boundaries}`;

  agentRegistry.set(newId, {
    id: newId, name, workspace: `${HOME}/.hermes/workspace-${slug}`,
    role, systemPrompt, settings: { wipe, continuity, model, boundaries },
  });

  console.log(`[hermes-adapter] Spawned agent: ${name} (${newId})`);

  // Broadcast presence so the 3D office loads the new agent immediately
  broadcastEvent({
    type: "event", event: "presence",
    payload: {
      sessions: {
        recent: [],
        byAgent: [...agentRegistry.keys()].map((aid) => ({
          agentId: aid,
          recent: [],
        })),
      },
    },
  });

  return JSON.stringify({ ok: true, agent_id: newId, name, role });
}

// ---------------------------------------------------------------------------
// Agent definition files -> system prompt. The office editor stores IDENTITY/SOUL/AGENTS/
// USER/TOOLS/MEMORY per agent; office agents (not the orchestrator, which has its own
// built-in prompt) are prompted from them. Empty or untouched templates are skipped.
// ---------------------------------------------------------------------------

const AGENT_PROMPT_FILES = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "TOOLS.md", "MEMORY.md"];

function isTemplateOnly(text) {
  // headings, "- Field:" placeholders and blank lines carry no instructions
  return text.replace(/^#.*$/gm, "").replace(/^\s*-\s*[^:\n]+:\s*$/gm, "").trim() === "";
}

function composeAgentSystemPrompt(agent) {
  if (!agent) return "";
  if (agent.id === AGENT_ID) return agent.systemPrompt || "";
  const sections = [];
  for (const name of AGENT_PROMPT_FILES) {
    const content = agentFiles.get(`${agent.id}/${name}`);
    if (typeof content === "string" && !isTemplateOnly(content)) sections.push(content.trim());
  }
  if (sections.length === 0) return agent.systemPrompt || "";
  return [
    `You are ${agent.name} (agent id: ${agent.id}), a member of the user's Claw3D office team. ` +
      "Your definition files follow; they override any generic assistant persona.",
    ...sections,
  ].join("\n\n---\n\n");
}

async function execDelegateTask(args) {
  const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!targetId || !message) return JSON.stringify({ ok: false, error: "agent_id and message required" });

  const agent = agentRegistry.get(targetId);
  if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });

  const sessionKey = `agent:${targetId}:${MAIN_KEY}`;
  const history = getHistory(sessionKey);
  const model = agent.settings.model || HERMES_MODEL;

  // Build messages for sub-agent
  const systemPrompt = composeAgentSystemPrompt(agent);
  const systemMsg = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  const contextHistory = agent.settings.wipe ? [] : [...history];
  const messages = [...systemMsg, ...contextHistory, { role: "user", content: message }];

  // Emit chat start event for this sub-agent
  const subRunId = randomId();
  let seqCounter = 0;
  const emitSub = (state, extra) => {
    broadcastEvent({ type: "event", event: "chat", seq: seqCounter++,
      payload: { runId: subRunId, sessionKey, state, ...extra } });
  };

  emitSub("delta", { message: { role: "assistant", content: "…" } });

  let responseText = "";
  try {
    const result = await streamOneTurn(messages, model, [], (partial) => {
      responseText = partial;
      emitSub("delta", { message: { role: "assistant", content: partial } });
    }, null);
    responseText = result.textContent;

    // Persist to sub-agent history
    if (agent.settings.continuity !== false) {
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: responseText });
      saveHistoryToDisk();
    }

    emitSub("final", { stopReason: "end_turn", message: { role: "assistant", content: responseText } });

    // Presence update for sub-agent session
    broadcastEvent({
      type: "event", event: "presence",
      payload: { sessions: { recent: [{ key: sessionKey, updatedAt: Date.now() }],
        byAgent: [{ agentId: targetId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }] } },
    });
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    emitSub("error", { errorMessage: message });
    return JSON.stringify({ ok: false, error: message });
  }

  return JSON.stringify({ ok: true, agent_id: targetId, response: responseText });
}

function execListTeam() {
  const members = [...agentRegistry.values()].map((a) => ({
    id: a.id, name: a.name, role: a.role || "",
    settings: a.settings,
  }));
  return JSON.stringify({ team: members });
}

function execConfigureAgent(args) {
  const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
  const agent = agentRegistry.get(targetId);
  if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });
  if (typeof args.name === "string" && args.name.trim()) agent.name = args.name.trim();
  if (typeof args.role === "string") agent.role = args.role.trim();
  if (typeof args.instructions === "string") agent.systemPrompt = args.instructions;
  if (typeof args.wipe === "boolean") agent.settings.wipe = args.wipe;
  if (typeof args.continuity === "boolean") agent.settings.continuity = args.continuity;
  if (typeof args.boundaries === "string") {
    agent.settings.boundaries = args.boundaries;
    if (agent.systemPrompt && args.boundaries) {
      agent.systemPrompt = agent.systemPrompt.replace(/\n\nBoundaries:.*$/s, "") + `\n\nBoundaries: ${args.boundaries}`;
    }
  }
  if (typeof args.model === "string" && args.model.trim()) agent.settings.model = args.model.trim();
  console.log(`[hermes-adapter] Configured agent: ${agent.name} (${targetId})`);
  broadcastEvent({
    type: "event", event: "presence",
    payload: {
      sessions: {
        recent: [],
        byAgent: [...agentRegistry.keys()].map((aid) => ({
          agentId: aid,
          recent: [],
        })),
      },
    },
  });
  return JSON.stringify({ ok: true, agent_id: targetId, name: agent.name, role: agent.role, settings: agent.settings });
}

function execDismissAgent(args) {
  const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
  if (!targetId || targetId === AGENT_ID) return JSON.stringify({ ok: false, error: "Cannot dismiss the main orchestrator." });
  const agent = agentRegistry.get(targetId);
  if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });
  agentRegistry.delete(targetId);
  clearHistory(`agent:${targetId}:${MAIN_KEY}`);
  console.log(`[hermes-adapter] Dismissed agent: ${agent.name} (${targetId})`);
  return JSON.stringify({ ok: true, dismissed: targetId });
}

function execReadAgentContext(args) {
  const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
  const agent = agentRegistry.get(targetId);
  if (!agent) return JSON.stringify({ ok: false, error: `Agent ${targetId} not found` });
  const lastN = Math.min(40, Math.max(1, typeof args.last_n === "number" ? Math.floor(args.last_n) : 10));
  const sessionKey = `agent:${targetId}:${MAIN_KEY}`;
  const history = getHistory(sessionKey);
  const messages = history.slice(-lastN);
  if (messages.length === 0) {
    return JSON.stringify({ ok: true, agent_id: targetId, name: agent.name, role: agent.role || "", message_count: 0, context: "(no conversation history yet)" });
  }
  const contextLines = messages.map((m) => {
    const role = m.role === "assistant" ? agent.name : "User";
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `[${role}]: ${content.slice(0, 800)}${content.length > 800 ? "…" : ""}`;
  });
  return JSON.stringify({
    ok: true,
    agent_id: targetId,
    name: agent.name,
    role: agent.role || "",
    message_count: history.length,
    showing_last: messages.length,
    context: contextLines.join("\n\n"),
  });
}

const persistAfter = async (result) => {
  const value = await result;
  saveAgentsToDisk();
  return value;
};

async function executeToolCall(tc, sendEvent) {
  console.log(`[hermes-adapter] Tool call: ${tc.name}`, JSON.stringify(tc.args).slice(0, 120));
  switch (tc.name) {
    case "spawn_agent":          return persistAfter(execSpawnAgent(tc.args, sendEvent));
    case "delegate_task":        return execDelegateTask(tc.args, sendEvent);
    case "list_team":            return execListTeam();
    case "configure_agent":      return persistAfter(execConfigureAgent(tc.args));
    case "dismiss_agent":        return persistAfter(execDismissAgent(tc.args));
    case "read_agent_context":   return execReadAgentContext(tc.args);
    default:                     return JSON.stringify({ ok: false, error: `Unknown tool: ${tc.name}` });
  }
}

// ---------------------------------------------------------------------------
// Agentic loop — handles multi-round tool-calling conversations
// ---------------------------------------------------------------------------

async function runAgenticLoop({ sessionKey, agentId, userMessage, model, tools, emitDelta, abortCheck, sendEvent }) {
  const agent = agentRegistry.get(agentId);
  const systemPrompt = composeAgentSystemPrompt(agent);
  const systemMsg = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  const history = getHistory(sessionKey);
  const contextHistory = (agent?.settings?.wipe) ? [] : [...history];
  let messages = [...systemMsg, ...contextHistory, { role: "user", content: userMessage }];

  let finalText = "";
  let round = 0;

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    const { textContent, toolCalls, finishReason } = await streamOneTurn(
      messages, model, tools, emitDelta, abortCheck
    );

    if (finishReason === "tool_calls" && toolCalls.length > 0) {
      // Inform user that tools are being executed (brief status text)
      const toolNames = toolCalls.map((t) => t.name).join(", ");
      const statusText = textContent || `Executing: ${toolNames}…`;
      if (statusText) emitDelta(statusText);

      // Add assistant message with tool_calls to messages
      messages.push({
        role: "assistant",
        content: textContent || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id, type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      // Execute all tool calls and collect results
      const toolResults = await Promise.all(
        toolCalls.map(async (tc) => {
          const result = await executeToolCall(tc, sendEvent);
          return { role: "tool", tool_call_id: tc.id, content: result };
        })
      );
      messages.push(...toolResults);
      continue;
    }

    // finish_reason = "stop" (or length/unknown) — we're done
    finalText = textContent;
    break;
  }

  // Persist to history
  if (agent?.settings?.continuity !== false) {
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: finalText });
    saveHistoryToDisk();
  }

  return finalText;
}

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

function resOk(id, payload) { return { type: "res", id, ok: true, payload: payload ?? {} }; }
function resErr(id, code, message) { return { type: "res", id, ok: false, error: { code, message } }; }

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

async function handleMethod(method, params, id, sendEvent) {
  const p = params || {};

  switch (method) {
    // --- Agent management ---------------------------------------------------

    case "agents.list": {
      const allAgents = [...agentRegistry.values()].map((agent) => ({
        id: agent.id, name: agent.name, workspace: agent.workspace,
        identity: { name: agent.name, emoji: "🤖" },
        role: agent.role,
        fullTools: agent.fullTools === true,
      }));
      return resOk(id, { defaultId: AGENT_ID, mainKey: MAIN_KEY, agents: allAgents });
    }

    case "agents.create": {
      const agentName = (typeof p.name === "string" && p.name.trim()) ? p.name.trim() : "Agent";
      const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const newId = `${slug}-${randomId().slice(0, 6)}`;
      const workspace = (typeof p.workspace === "string" && p.workspace)
        ? p.workspace : `${HOME}/.hermes/workspace-${slug}`;
      agentRegistry.set(newId, {
        id: newId, name: agentName, workspace,
        fullTools: p.fullTools === true,
        role: (typeof p.role === "string") ? p.role.trim() : "",
        systemPrompt: (typeof p.systemPrompt === "string" && p.systemPrompt.trim())
          ? p.systemPrompt.trim() : `You are ${agentName}.`,
        settings: { wipe: false, continuity: true, model: HERMES_MODEL },
      });
      saveAgentsToDisk();
      return resOk(id, { agentId: newId, name: agentName, workspace });
    }

    case "agents.delete": {
      const delId = typeof p.agentId === "string" ? p.agentId : "";
      if (delId && delId !== AGENT_ID) {
        agentRegistry.delete(delId);
        clearHistory(`agent:${delId}:${MAIN_KEY}`);
        saveAgentsToDisk();
      }
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.update": {
      const updId = typeof p.agentId === "string" ? p.agentId : "";
      const existing = agentRegistry.get(updId);
      if (existing) {
        if (typeof p.name === "string" && p.name.trim()) existing.name = p.name.trim();
        if (typeof p.workspace === "string" && p.workspace.trim()) existing.workspace = p.workspace.trim();
        if (typeof p.role === "string") existing.role = p.role.trim();
        if (typeof p.systemPrompt === "string" && p.systemPrompt.trim()) existing.systemPrompt = p.systemPrompt.trim();
        if (typeof p.fullTools === "boolean") existing.fullTools = p.fullTools;
        saveAgentsToDisk();
      }
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.files.get": {
      const key = `${p.agentId || AGENT_ID}/${p.name || ""}`;
      const content = agentFiles.get(key);
      return resOk(id, { file: content !== undefined ? { content } : { missing: true } });
    }

    case "agents.files.set": {
      const key = `${p.agentId || AGENT_ID}/${p.name || ""}`;
      agentFiles.set(key, typeof p.content === "string" ? p.content : "");
      saveAgentsToDisk();
      return resOk(id, {});
    }

    // --- Config -------------------------------------------------------------

    case "config.get":
      return resOk(id, { config: { gateway: { reload: { mode: "hot" } } },
        hash: "hermes-adapter", exists: true, path: CONFIG_PATH });

    case "config.patch":
    case "config.set":
      return resOk(id, { hash: "hermes-adapter" });

    // --- Sessions -----------------------------------------------------------

    case "sessions.list": {
      let sharedMessages = null;
      if (SHARED_SESSION_ENABLED) {
        try { sharedMessages = await getSharedHistory(); } catch { sharedMessages = null; }
      }
      const sessions = [...agentRegistry.values()].map((agent) => {
        const sessionKey = `agent:${agent.id}:${MAIN_KEY}`;
        const history = (SHARED_SESSION_ENABLED && agent.id === AGENT_ID && sharedMessages)
          ? sharedMessages : getHistory(sessionKey);
        const settings = sessionSettings.get(sessionKey) || {};
        return {
          key: sessionKey, agentId: agent.id,
          updatedAt: history.length > 0 ? Date.now() : null,
          displayName: "Main",
          origin: { label: agent.name, provider: "hermes" },
          model: settings.model || agent.settings?.model || HERMES_MODEL,
          modelProvider: "hermes",
        };
      });
      return resOk(id, { sessions });
    }

    case "sessions.preview": {
      const keys = Array.isArray(p.keys) ? p.keys : [];
      const limit = typeof p.limit === "number" ? p.limit : 8;
      const maxChars = typeof p.maxChars === "number" ? p.maxChars : 240;
      const histories = await Promise.all(
        keys.map((key) => historyForKey(key).catch(() => getHistory(key))),
      );
      const previews = keys.map((key, index) => {
        const history = histories[index];
        if (history.length === 0) return { key, status: "empty", items: [] };
        const items = history.slice(-limit).map((msg) => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          text: String(msg.content || "").slice(0, maxChars),
          timestamp: Date.now(),
        }));
        return { key, status: "ok", items };
      });
      return resOk(id, { ts: Date.now(), previews });
    }

    case "sessions.patch": {
      const key = typeof p.key === "string" ? p.key : MAIN_SESSION_KEY;
      const current = sessionSettings.get(key) || {};
      const next = { ...current };
      if (p.model !== undefined) next.model = typeof p.model === "string" ? p.model.trim() : p.model;
      if (p.thinkingLevel !== undefined) next.thinkingLevel = p.thinkingLevel;
      if (p.execHost !== undefined) next.execHost = p.execHost;
      if (p.execSecurity !== undefined) next.execSecurity = p.execSecurity;
      if (p.execAsk !== undefined) next.execAsk = p.execAsk;
      sessionSettings.set(key, next);
      const resolvedModel = await resolveHermesModel(next.model || HERMES_MODEL);
      return resOk(id, { ok: true, key, entry: { thinkingLevel: next.thinkingLevel },
        resolved: { model: resolvedModel, modelProvider: "hermes" } });
    }

    case "sessions.reset": {
      const key = typeof p.key === "string" ? p.key : MAIN_SESSION_KEY;
      if (SHARED_SESSION_ENABLED && key === MAIN_SESSION_KEY) {
        const state = readSharedSessionState();
        if (state.pinned && state.id && state.owned) {
          // Adapter-owned shared session: delete and create a fresh pinned one.
          try {
            const del = await hermesDelete(`/api/sessions/${encodeURIComponent(state.id)}`);
            del.resume();
          } catch { /* ignore */ }
          const title = sharedSessionTitle();
          const createdRes = await hermesPost("/api/sessions", sharedSessionCreateBody(title));
          const createdPayload = await readJsonBody(createdRes);
          const created = createdPayload?.session?.id;
          if (!created) return resErr(id, "shared_reset_failed",
            extractOpenAiStyleError(createdPayload, "Could not create shared session"));
          writeSharedSessionState({ id: created, pinned: true, owned: true, title });
          sharedSessionMemo = { id: created, at: Date.now() };
          return resOk(id, { ok: true, sharedSessionId: created });
        }
        // Shared chat follows a Telegram session — never destroy the user's DM session.
        return resOk(id, { ok: true,
          note: "Shared chat follows the Telegram session; use /new in Telegram to start fresh there." });
      }
      const subAgentForKey = key.startsWith("agent:") ? agentRegistry.get(key.split(":")[1]) : null;
      if (SHARED_SESSION_ENABLED && subAgentForKey?.fullTools && subAgentForKey.sessionApiId) {
        // Full-tools sub-agent: wipe its private Hermes session (recreated on next chat).
        try {
          const del = await hermesDelete(`/api/sessions/${encodeURIComponent(subAgentForKey.sessionApiId)}`);
          del.resume();
        } catch { /* ignore */ }
        subAgentForKey.sessionApiId = null;
        saveAgentsToDisk();
        return resOk(id, { ok: true });
      }
      clearHistory(key);
      return resOk(id, { ok: true });
    }

    // --- Chat ---------------------------------------------------------------

    case "chat.send": {
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : MAIN_SESSION_KEY;
      const userMessage = typeof p.message === "string" ? p.message.trim() : String(p.message || "").trim();
      const runId = (typeof p.idempotencyKey === "string" && p.idempotencyKey) ? p.idempotencyKey : randomId();

      if (!userMessage) return resOk(id, { status: "no-op", runId });

      // Resolve which agent owns this session
      const sessionAgentId = sessionKey.startsWith("agent:") ? sessionKey.split(":")[1] : AGENT_ID;
      const agent = agentRegistry.get(sessionAgentId);
      const isOrchestrator = sessionAgentId === AGENT_ID;

      let aborted = false;
      activeRuns.set(runId, {
        runId,
        sessionKey,
        agentId: sessionAgentId,
        abort() { aborted = true; },
      });

      setImmediate(async () => {
        const model = (sessionSettings.get(sessionKey) || {}).model
          || agent?.settings?.model || HERMES_MODEL;
        let seqCounter = 0;

        const emitChat = (state, extra) => {
          sendEvent({ type: "event", event: "chat", seq: seqCounter++,
            payload: { runId, sessionKey, state, ...extra } });
        };

        const onTextDelta = (partial) => {
          if (!aborted) emitChat("delta", { message: { role: "assistant", content: partial } });
        };

        try {
          // Secretary (orchestrator) turns run in the shared Hermes session (one thread
          // with Telegram). fullTools sub-agents run in their own private Hermes session
          // with the complete toolset (isolated from Telegram). Other sub-agents keep the
          // local text-only loop below and never enter a Hermes session.
          if (SHARED_SESSION_ENABLED && (isOrchestrator || agent?.fullTools)) {
            // Only the Secretary's own turns touch the shared transcript; worker turns must not
            // pause the Telegram live sync (they can run for many minutes).
            if (isOrchestrator) officeSharedTurns += 1;
            let turn;
            try {
              if (!isOrchestrator) resetTeamSessionsOnNewRequest(userMessage);
              const turnSessionId = isOrchestrator ? undefined : await ensureAgentSession(sessionAgentId);
              const persona = isOrchestrator ? "" : (composeAgentSystemPrompt(agent) || "");
              turn = await runSharedSessionTurn({
                sessionId: turnSessionId,
                userMessage: persona ? `${persona}\n\n---\n\n${userMessage}` : userMessage,
                emitDelta: onTextDelta, abortCheck: () => aborted,
              });
            } finally {
              if (isOrchestrator) {
                officeSharedTurns -= 1;
                sharedSyncFingerprint = null; // re-baseline so live sync doesn't echo this office turn
              }
            }
            if (turn.cancelled || aborted) {
              emitChat("aborted", {});
            } else {
              emitChat("final", { stopReason: "end_turn",
                message: { role: "assistant", content: turn.text } });
              sendEvent({ type: "event", event: "presence", seq: seqCounter++,
                payload: { sessions: { recent: [{ key: sessionKey, updatedAt: Date.now() }],
                  byAgent: [{ agentId: sessionAgentId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }] } } });
            }
            return;
          }

          // Only the orchestrator gets team management tools
          const tools = isOrchestrator ? TEAM_TOOLS : [];

          const finalText = await runAgenticLoop({
            sessionKey, agentId: sessionAgentId, userMessage,
            model, tools, emitDelta: onTextDelta,
            abortCheck: () => aborted, sendEvent,
          });

          if (aborted) {
            emitChat("aborted", {});
          } else {
            emitChat("final", { stopReason: "end_turn",
              message: { role: "assistant", content: finalText } });
            sendEvent({ type: "event", event: "presence", seq: seqCounter++,
              payload: { sessions: { recent: [{ key: sessionKey, updatedAt: Date.now() }],
                byAgent: [{ agentId: sessionAgentId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }] } } });
          }
        } catch (err) {
          if (!aborted) emitChat("error", { errorMessage: sanitizeErrorMessage(err) || "Hermes API error" });
          else emitChat("aborted", {});
        } finally {
          activeRuns.delete(runId);
        }
      });

      return resOk(id, { status: "started", runId });
    }

    case "chat.abort": {
      const runId = typeof p.runId === "string" ? p.runId.trim() : "";
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
      let aborted = 0;
      if (runId) {
        const handle = activeRuns.get(runId);
        if (handle) {
          handle.abort();
          activeRuns.delete(runId);
          aborted += 1;
        }
      } else if (sessionKey) {
        for (const [activeRunId, handle] of activeRuns.entries()) {
          if (handle.sessionKey !== sessionKey) continue;
          handle.abort();
          activeRuns.delete(activeRunId);
          aborted += 1;
        }
      }
      return resOk(id, { ok: true, aborted });
    }

    case "chat.history": {
      const histKey = typeof p.sessionKey === "string" ? p.sessionKey : MAIN_SESSION_KEY;
      try {
        return resOk(id, { sessionKey: histKey, messages: await historyForKey(histKey) });
      } catch (err) {
        console.warn("[hermes-adapter] History fetch failed:", sanitizeErrorMessage(err));
      }
      return resOk(id, { sessionKey: histKey, messages: getHistory(histKey) });
    }

    case "agent.wait": {
      const { runId, timeoutMs = 30000 } = p;
      const start = Date.now();
      while (activeRuns.has(runId) && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return resOk(id, { status: activeRuns.has(runId) ? "running" : "done" });
    }

    // --- Approvals ----------------------------------------------------------

    case "exec.approvals.get":
      return resOk(id, { path: "", exists: true, hash: "hermes-approvals",
        file: { version: 1, defaults: { security: "full", ask: "off", autoAllowSkills: true }, agents: {} } });

    case "exec.approvals.set":
      return resOk(id, { hash: "hermes-approvals" });

    case "exec.approval.resolve":
      return resOk(id, { ok: true });

    // --- Status & heartbeat -------------------------------------------------

    case "status": {
      const recent = [...agentRegistry.keys()].flatMap((aid) => {
        const h = getHistory(`agent:${aid}:${MAIN_KEY}`);
        return h.length > 0 ? [{ key: `agent:${aid}:${MAIN_KEY}`, updatedAt: Date.now() }] : [];
      });
      return resOk(id, { sessions: { recent,
        byAgent: [...agentRegistry.keys()].map((aid) => ({
          agentId: aid,
          recent: recent.filter((r) => r.key.includes(`:${aid}:`)),
        })) } });
    }

    case "wake":
      return resOk(id, { ok: true });

    // --- Skills & models ----------------------------------------------------

    case "skills.status":
      return resOk(id, {
        workspaceDir: path.dirname(HERMES_SKILLS_HOST_DIR),
        managedSkillsDir: HERMES_SKILLS_HOST_DIR,
        skills: listHermesSkills(),
      });

    case "models.list":
      try {
        const models = await fetchHermesModels();
        return resOk(id, {
          models: (models.length > 0 ? models : [HERMES_MODEL]).map((modelId) => ({
            id: modelId,
            name: modelId,
          })),
        });
      } catch {
        return resOk(id, { models: [{ id: HERMES_MODEL, name: HERMES_MODEL }] });
      }

    case "tasks.list":
      return resOk(id, { tasks: [] });

    // --- Cron jobs ----------------------------------------------------------

    case "cron.list": {
      const includeDisabled = p.includeDisabled !== false;
      const jobs = [...cronJobs.values()];
      return resOk(id, { jobs: includeDisabled ? jobs : jobs.filter((j) => j.enabled) });
    }

    case "cron.add": {
      const jobId = randomId();
      const job = {
        id: jobId, name: typeof p.name === "string" ? p.name : "Cron Job",
        agentId: typeof p.agentId === "string" ? p.agentId : AGENT_ID,
        sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : MAIN_SESSION_KEY,
        description: typeof p.description === "string" ? p.description : "",
        enabled: p.enabled !== false, deleteAfterRun: Boolean(p.deleteAfterRun),
        updatedAtMs: Date.now(), schedule: p.schedule || { kind: "every", everyMs: 3600000 },
        sessionTarget: p.sessionTarget || "main", wakeMode: p.wakeMode || "next-heartbeat",
        payload: p.payload || { kind: "systemEvent", text: "tick" }, state: {},
      };
      cronJobs.set(jobId, job);
      return resOk(id, job);
    }

    case "cron.remove": {
      const jobId = typeof p.id === "string" ? p.id : "";
      return resOk(id, { ok: true, removed: cronJobs.delete(jobId) });
    }

    case "cron.patch": {
      const jobId = typeof p.id === "string" ? p.id : "";
      const job = cronJobs.get(jobId);
      if (!job) return resOk(id, { ok: false, error: "not_found" });
      const updated = { ...job };
      if (p.enabled !== undefined) updated.enabled = Boolean(p.enabled);
      if (p.name !== undefined) updated.name = String(p.name);
      if (p.schedule !== undefined) updated.schedule = p.schedule;
      if (p.payload !== undefined) updated.payload = p.payload;
      updated.updatedAtMs = Date.now();
      cronJobs.set(jobId, updated);
      return resOk(id, { ok: true, job: updated });
    }

    case "cron.run": {
      const jobId = typeof p.id === "string" ? p.id : "";
      const job = cronJobs.get(jobId);
      if (!job) return resOk(id, { ok: false });
      cronJobs.set(jobId, { ...job, state: { ...job.state, runningAtMs: Date.now() } });
      setTimeout(() => {
        const current = cronJobs.get(jobId);
        if (!current) return;
        const done = { ...current, state: { ...current.state, runningAtMs: undefined, lastRunAtMs: Date.now(), lastStatus: "ok" } };
        cronJobs.set(jobId, done);
        broadcastEvent({ type: "event", event: "cron", payload: { action: "finished", jobId, status: "ok", summary: done } });
      }, 3000);
      return resOk(id, { ok: true, ran: true });
    }

    default:
      console.warn(`[hermes-adapter] Unhandled method: ${method}`);
      return resOk(id, {});
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

function startAdapter() {
  if (HEARTBEATS_ENABLED) {
    setInterval(() => {
      runDueHeartbeat().catch((err) => {
        heartbeatRunning = false;
        console.warn("[hermes-adapter] Heartbeat failed:", sanitizeErrorMessage(err));
      });
    }, HEARTBEAT_TICK_MS);
  }
  if (SHARED_SESSION_ENABLED) {
    setInterval(() => {
      pollSharedSession().catch((err) =>
        console.warn("[hermes-adapter] Shared live sync failed:", sanitizeErrorMessage(err)));
    }, SHARED_SYNC_INTERVAL_MS);
  }
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Hermes Gateway Adapter – OK\n");
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("error", (err) => {
    if (err.code !== "EADDRINUSE") console.error("[hermes-adapter] Server error:", sanitizeErrorMessage(err));
  });

  wss.on("connection", (ws) => {
    let connected = false;
    let globalSeq = 0;

    const send = (frame) => {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify(frame)); }
        catch (e) { console.error("[hermes-adapter] send error:", sanitizeErrorMessage(e)); }
      }
    };

    // Register this connection's send function for broadcasts
    const sendEventFn = (frame) => {
      if (frame.type === "event" && typeof frame.seq !== "number") frame.seq = globalSeq++;
      send(frame);
    };
    activeSendEventFns.add(sendEventFn);

    send({ type: "event", event: "connect.challenge", payload: { nonce: randomId() } });

    ws.on("message", async (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (!frame || typeof frame !== "object" || frame.type !== "req") return;
      const { id, method, params } = frame;
      if (typeof id !== "string" || typeof method !== "string") return;

      if (method === "connect") {
        connected = true;
        const allAgents = [...agentRegistry.values()].map((a) => ({ agentId: a.id, name: a.name, isDefault: a.id === AGENT_ID }));
        send({
          type: "res", id, ok: true,
          payload: {
            type: "hello-ok", protocol: 3,
            adapterType: "hermes",
            features: { methods: ["agents.list","agents.create","agents.delete","agents.update",
              "sessions.list","sessions.preview","sessions.patch","sessions.reset",
              "chat.send","chat.abort","chat.history","agent.wait",
              "status","config.get","config.set","config.patch",
              "agents.files.get","agents.files.set",
              "exec.approvals.get","exec.approvals.set","exec.approval.resolve",
              "wake","skills.status","models.list",
              "tasks.list",
              "cron.list","cron.add","cron.remove","cron.patch","cron.run"],
              events: ["chat","presence","heartbeat","cron"] },
            snapshot: { health: { agents: allAgents, defaultAgentId: AGENT_ID },
              sessionDefaults: { mainKey: MAIN_KEY } },
            auth: { role: "operator", scopes: ["operator.admin","operator.approvals"] },
            policy: { tickIntervalMs: 30000 },
          },
        });
        return;
      }

      if (!connected) { send(resErr(id, "not_connected", "Send connect first.")); return; }

      try {
        const response = await handleMethod(method, params, id, sendEventFn);
        send(response);
      } catch (err) {
        const message = sanitizeErrorMessage(err);
        console.error(`[hermes-adapter] Error handling ${method}:`, message);
        send(resErr(id, "internal_error", message || "Internal error"));
      }
    });

    ws.on("close", () => activeSendEventFns.delete(sendEventFn));
    ws.on("error", (err) => {
      console.error("[hermes-adapter] WebSocket error:", sanitizeErrorMessage(err));
      activeSendEventFns.delete(sendEventFn);
    });
  });

  httpServer.listen(ADAPTER_PORT, "127.0.0.1", () => {
    console.log(`\n[hermes-adapter] ✓ Listening on ws://localhost:${ADAPTER_PORT}`);
    console.log(`[hermes-adapter] ✓ Forwarding to Hermes API at ${HERMES_API_URL}`);
    console.log(`[hermes-adapter] ✓ Model: ${HERMES_MODEL}`);
    console.log(`[hermes-adapter] ✓ Multi-agent orchestration: ENABLED`);
    if (SHARED_SESSION_ENABLED) {
      resolveSharedSessionId()
        .then((sid) => console.log(`[hermes-adapter] ✓ Shared session (office↔Telegram): ${sid}, live sync every ${SHARED_SYNC_INTERVAL_MS}ms`))
        .catch((err) => console.warn("[hermes-adapter] Shared session resolve failed:", sanitizeErrorMessage(err)));
    } else {
      console.log("[hermes-adapter] Shared session: OFF (local history)");
    }
    console.log(`\nOpen Claw3D → ws://localhost:${ADAPTER_PORT}\n`);
  });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[hermes-adapter] Port ${ADAPTER_PORT} in use. Set HERMES_ADAPTER_PORT to change it.`);
    } else {
      console.error("[hermes-adapter] Server error:", sanitizeErrorMessage(err));
    }
    process.exit(1);
  });
}

loadAgentsFromDisk();
loadHistoryFromDisk();
startAdapter();
