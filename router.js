#!/usr/bin/env node
/**
 * claude-smart-router
 * ---------------------------------------------------------------
 * A tiny local proxy that sits between Claude Code and your model
 * backends (GLM, Anthropic, Ollama, or anything that speaks the
 * Anthropic Messages API). For every request it:
 *
 *   1. Looks at your latest message + conversation context.
 *   2. Asks a cheap "triage" model to judge complexity + clarity.
 *   3. Short follow-ups inherit complexity from the session context
 *      (borrowed from alexrudloff/llmrouter).
 *   4. If the prompt is vague, appends a clarification block that
 *      states the assumptions the router is proceeding with.
 *   5. If tools are present, applies a complexity floor to protect
 *      against prompt-injection on weak models.
 *   6. Routes the (possibly annotated) request to the appropriate
 *      tier backend (5-tier: super_easy → easy → medium → hard →
 *      super_hard, or legacy 2-tier: light / heavy).
 *   7. Streams the response straight back to Claude Code.
 *
 * Zero npm dependencies — just Node.js 18+ (uses global fetch).
 *
 * Usage:
 *   1. cp config.example.json config.json   (fill in your keys)
 *   2. node router.js
 *   3. Point Claude Code at it (see README.md)
 * ---------------------------------------------------------------
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { Readable } = require("stream");

// ---------------------------------------------------------------
// Key management: `claude-smart-router key set|list|remove`
// Claude-Code-style — keys typed blind, stored OUTSIDE any project
// directory in ~/.claude-smart-router/keys.json (0600), so no repo or
// agent workspace ever holds them. Real env vars still win; .env
// supplies what's neither in env nor the keystore.
// ---------------------------------------------------------------

const KEYSTORE_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || ".",
  ".claude-smart-router"
);
const KEYSTORE_PATH = path.join(KEYSTORE_DIR, "keys.json");
const KEY_NAMES = ["route", "classifier", "router"];

function readKeystore() {
  try {
    return JSON.parse(fs.readFileSync(KEYSTORE_PATH, "utf8")) || {};
  } catch (_) {
    return {};
  }
}

function writeKeystore(keys) {
  fs.mkdirSync(KEYSTORE_DIR, { recursive: true });
  fs.writeFileSync(KEYSTORE_PATH, JSON.stringify(keys, null, 2) + "\n", {
    mode: 0o600,
    flag: "w",
  });
}

// Prompt on the TTY (not the piped stdout) so the typed key never ends
// up in captured output. Characters aren't echoed — this is a plain
// readline with output muted, the same UX as every CLI "password:".
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    rl.output.write = () => {}; // mute echo
  });
}

function maskKey(k) {
  if (!k) return "(not set)";
  if (k.length <= 8) return k[0] + "***";
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}

function cmdKey(args) {
  const sub = args[0];
  if (sub === "set") {
    const name = args[1];
    if (!name || !KEY_NAMES.includes(name)) {
      console.error(`Usage: claude-smart-router key set <${KEY_NAMES.join("|")}>\n` +
        `  route       — key for all route tiers (ROUTE_API_KEY equivalent)\n` +
        `  classifier  — key for the triage model (CLASSIFIER_API_KEY equivalent)\n` +
        `  router      — token clients must present to use this proxy (ROUTER_TOKEN equivalent)`);
      process.exit(1);
    }
    askHidden(`${name} key (input hidden): `).then((val) => {
      if (!val) {
        console.error("No input — nothing saved.");
        process.exit(1);
      }
      const keys = readKeystore();
      keys[name] = val;
      writeKeystore(keys);
      console.log(`Saved ${name} key to ${KEYSTORE_PATH} (visible as ${maskKey(val)})`);
      process.exit(0);
    });
    return true;
  }
  if (sub === "list") {
    const keys = readKeystore();
    console.log(`Keystore: ${KEYSTORE_PATH}`);
    for (const name of KEY_NAMES) console.log(`  ${name.padEnd(11)} ${maskKey(keys[name])}`);
    process.exit(0);
  }
  if (sub === "remove") {
    const name = args[1];
    if (!name || !KEY_NAMES.includes(name)) {
      console.error(`Usage: claude-smart-router key remove <${KEY_NAMES.join("|")}>`);
      process.exit(1);
    }
    const keys = readKeystore();
    if (!keys[name]) {
      console.error(`No ${name} key stored.`);
      process.exit(1);
    }
    delete keys[name];
    writeKeystore(keys);
    console.log(`Removed ${name} key.`);
    process.exit(0);
  }
  console.error(
    `Usage: claude-smart-router key <set|list|remove>\n` +
    `  key set <name>      — type a key blind; stored in ${KEYSTORE_DIR}\n` +
    `  key list            — show stored keys (masked)\n` +
    `  key remove <name>   — delete one`
  );
  process.exit(1);
}

// Entry-point dispatch. Handled before config/.env so key commands work
// with no config present. Anything else falls through to the server.
const argv = process.argv.slice(2);
if (argv[0] === "key") {
  cmdKey(argv.slice(1));
  return; // cmdKey exits on its own; never fall through to the server
}
if (argv[0] === "--help" || argv[0] === "-h") {
  console.log(
    `claude-smart-router — local complexity-routing proxy for Claude Code\n\n` +
    `Usage:\n` +
    `  claude-smart-router            start the proxy (reads config.json from cwd)\n` +
    `  claude-smart-router key set <route|classifier|router>\n` +
    `                                 store an API key in ~/.claude-smart-router/ (typed blind)\n` +
    `  claude-smart-router key list   show stored keys (masked)\n` +
    `  claude-smart-router key remove <name>\n\n` +
    `Config lookup: ./config.json, then next to the installed router.js.\n` +
    `Key lookup: env vars > keystore > .env\n` +
    `Docs: README.md`
  );
  process.exit(0);
}

// ---------------------------------------------------------------
// Path resolution. Config, .env, and ROUTES.md are looked up in the
// CURRENT WORKING DIRECTORY first (so an npm-installed CLI finds the
// user's files where they run it), falling back to next to router.js
// (repo checkout). Explicit env vars (ROUTER_CONFIG / ROUTER_ENV_PATH /
// ROUTES_PATH) always win and skip the search.
// ---------------------------------------------------------------

function resolveFile(explicit, basename) {
  if (explicit) return explicit;
  const cwdPath = path.join(process.cwd(), basename);
  if (fs.existsSync(cwdPath)) return cwdPath;
  return path.join(__dirname, basename);
}

// ---------------------------------------------------------------
// Env layering (zero-dependency, dotenv-style).
// Precedence: real environment variables > ~/.claude-smart-router
// keystore > .env. Keys typed via `key set` land in the keystore and
// never need to live in a project directory at all.
// ---------------------------------------------------------------

// Keystore applies BEFORE .env so a stored key beats a placeholder left
// in a project .env — and after real env, since it only fills vars that
// are still undefined. Net precedence: env vars > keystore > .env.
(function applyKeystore() {
  const keys = readKeystore();
  const map = { route: "ROUTE_API_KEY", classifier: "CLASSIFIER_API_KEY", router: "ROUTER_TOKEN" };
  let applied = [];
  for (const [name, envVar] of Object.entries(map)) {
    if (keys[name] && process.env[envVar] === undefined) {
      process.env[envVar] = keys[name];
      applied.push(name);
    }
  }
  if (applied.length) console.log(`[router] keystore supplied: ${applied.join(", ")}`);
})();

(function loadDotEnv() {
  const envPath = resolveFile(process.env.ROUTER_ENV_PATH, ".env");
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch (_) {
    return; // no .env — nothing to do
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue; // blank line or # comment
    const [, key, val] = m;
    if (process.env[key] !== undefined) continue; // real env / keystore win
    process.env[key] = val.replace(/^["']|["']$/g, "");
  }
  console.log(`[router] loaded env vars from ${envPath}`);
})();

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

const CONFIG_PATH = resolveFile(process.env.ROUTER_CONFIG, "config.json");
const ROUTES_PATH = resolveFile(process.env.ROUTES_PATH, "ROUTES.md");

function loadConfig() {
  let cfgPath = CONFIG_PATH;
  let usingDefaults = false;
  if (!fs.existsSync(cfgPath)) {
    // Zero-config startup: fall back to the bundled example (GLM tiers,
    // port 8787). A config.json dropped next to the cwd or the install
    // always wins over this.
    const bundled = path.join(__dirname, "config.example.json");
    if (!fs.existsSync(bundled)) {
      const lookedIn = [path.join(process.cwd(), "config.json"), path.join(__dirname, "config.json")];
      console.error(
        `\n[router] No config found. Looked in:\n` +
          lookedIn.map((p) => `[router]   - ${p}`).join("\n") +
          `\n[router] Copy config.example.json to config.json in your working directory and fill in your API keys.\n`
      );
      process.exit(1);
    }
    cfgPath = bundled;
    usingDefaults = true;
  }
  const raw = fs.readFileSync(cfgPath, "utf8");
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error(`\n[router] ${cfgPath} is not valid JSON: ${e.message}\n`);
    process.exit(1);
  }
  cfg.__usingDefaults = usingDefaults;
  cfg.__configPath = cfgPath;
  validateConfig(cfg);
  return cfg;
}

// Fail fast at startup with actionable messages rather than 500s on
// the first request. Checks the structural essentials only — key
// validity is the upstream's problem.
function validateConfig(cfg) {
  const problems = [];
  if (!cfg || typeof cfg !== "object") {
    console.error("\n[router] config.json must be a JSON object.\n");
    process.exit(1);
  }
  if (!cfg.routes || typeof cfg.routes !== "object" || Object.keys(cfg.routes).length === 0) {
    problems.push('"routes" must be a non-empty object mapping tiers to models');
  } else {
    const sharedBaseUrl = cfg.baseUrl || cfg.defaults?.baseUrl;
    for (const [name, route] of Object.entries(cfg.routes)) {
      const r = typeof route === "string" ? { model: route } : route;
      if (!r.model) problems.push(`routes.${name} is missing "model"`);
      if (!r.baseUrl && !sharedBaseUrl) {
        problems.push(`routes.${name} is missing "baseUrl" (directly or via top-level baseUrl/defaults.baseUrl)`);
      }
    }
  }
  if (!cfg.classifier || !cfg.classifier.model) {
    problems.push('"classifier.model" is required (a cheap fast model to triage requests)');
  }
  if (problems.length) {
    console.error(`\n[router] Invalid config at ${CONFIG_PATH}:`);
    for (const p of problems) console.error(`[router]   - ${p}`);
    console.error("");
    process.exit(1);
  }
}

// Normalize shorthand config forms:
//   - routes may be plain model strings: "hard": "glm-5.2"
//   - a top-level baseUrl/apiKey (or a "defaults" object) is inherited by
//     every route and the classifier when they don't specify their own.
// Full per-route objects still work and still win over the shared values —
// useful the day one tier moves to a different provider.
function normalizeConfig(cfg) {
  const defaults = {
    baseUrl: cfg.defaults?.baseUrl || cfg.baseUrl,
    apiKey: cfg.defaults?.apiKey || cfg.apiKey,
  };
  for (const [name, route] of Object.entries(cfg.routes || {})) {
    const r = typeof route === "string" ? { model: route } : { ...route };
    if (!r.baseUrl && defaults.baseUrl) r.baseUrl = defaults.baseUrl;
    if (!r.apiKey && defaults.apiKey) r.apiKey = defaults.apiKey;
    cfg.routes[name] = r;
  }
  if (cfg.classifier) {
    if (!cfg.classifier.baseUrl && defaults.baseUrl) cfg.classifier.baseUrl = defaults.baseUrl;
    if (!cfg.classifier.apiKey && defaults.apiKey) cfg.classifier.apiKey = defaults.apiKey;
  }
  return cfg;
}

let config = normalizeConfig(loadConfig());

const PORT = process.env.PORT || config.port || 8787;
// Default 127.0.0.1 — this proxy injects API keys into upstream requests,
// so it must not be reachable from the network unless explicitly opened up
// (set "host": "0.0.0.0" in config or HOST env var, ideally with routerToken).
const HOST = process.env.HOST || config.host || "127.0.0.1";
const CLARIFY_ENABLED = config.clarify !== false;
const MIN_WORDS_TO_CLASSIFY = config.skipClassifyMinWords ?? 4;
const ANTHROPIC_VERSION = config.anthropicVersion || "2023-06-01";
const UPSTREAM_TIMEOUT_MS = config.upstreamTimeoutMs || 120_000;
const MAX_SESSIONS = config.maxSessions || 500;
// Reject /v1/messages bodies above this size (default 20 MB — generous
// headroom over even very large Claude Code contexts) so a runaway client
// can't exhaust memory. Configurable as maxBodyMb.
const MAX_BODY_BYTES = Math.floor((config.maxBodyMb || 20) * 1024 * 1024);

// Optional proxy auth: if routerToken is set in config, all requests
// must include Authorization: Bearer <token> matching it.
const ROUTER_TOKEN = process.env.ROUTER_TOKEN || config.routerToken || null;

// ---------------------------------------------------------------
// 5-tier complexity levels (from alexrudloff/llmrouter)
// Ordered from cheapest to most expensive.
// ---------------------------------------------------------------

const COMPLEXITY_LEVELS = ["super_easy", "easy", "medium", "hard", "super_hard"];

// Map legacy 2-tier labels to 5-tier equivalents for backward compat.
// Direction matters here: complexity values (the 5-tier vocabulary) are what
// arrive from the classifier; legacy route names (light/heavy) are config
// keys. So the usable lookup is complexity -> legacy route.
const LEGACY_COMPLEXITY_TO_TIER = {
  super_easy: "light",
  easy: "light",
  medium: "heavy", // legacy had no middle tier; medium+ work belongs upstream
  hard: "heavy",
  super_hard: "heavy",
};

// Tool-aware routing: when tools are present, bump complexity to at
// least this floor (from alexrudloff/llmrouter). Set in config as
// tools.minComplexity. Default: "medium" (super_easy/easy → medium).
const TOOLS_MIN_COMPLEXITY = config.tools?.minComplexity || "medium";
const TOOLS_FIXED_MODEL = config.tools?.model || null; // Override: force a specific model for tool calls

// Cost weights per tier (from ulab-uiuc/LLMRouter cost-aware concept).
// Used for logging only in this proxy — extend if you want budget enforcement.
const COST_WEIGHTS = config.costWeights || {
  super_easy: 0.05,
  easy: 0.15,
  medium: 0.40,
  hard: 0.70,
  super_hard: 1.00,
};

// ---------------------------------------------------------------
// Sticky session map: lets us skip re-classifying tool-result
// continuations AND lets short follow-ups inherit context complexity
// (from alexrudloff/llmrouter's context-inheritance pattern).
// ---------------------------------------------------------------

const sessionBackend = new Map();

// ---------------------------------------------------------------
// API key resolution: env vars override config.json
// Supports per-route env vars + generic ROUTE_<NAME>_API_KEY pattern.
// ---------------------------------------------------------------

(function applyEnvOverrides() {
  // config.classifier is validated at load, but stay defensive — this IIFE
  // must never crash the process over a missing key.
  if (process.env.CLASSIFIER_API_KEY && config.classifier) {
    config.classifier.apiKey = process.env.CLASSIFIER_API_KEY;
  }
  // Generic key for all routes first, then per-route vars on top (they win).
  if (process.env.ROUTE_API_KEY) {
    for (const routeCfg of Object.values(config.routes || {})) {
      routeCfg.apiKey = process.env.ROUTE_API_KEY;
    }
  }
  // Dynamic per-route env vars: ROUTE_SUPER_EASY_API_KEY, ROUTE_EASY_API_KEY, etc.
  for (const [routeName, routeCfg] of Object.entries(config.routes || {})) {
    const envVar = `ROUTE_${routeName.toUpperCase()}_API_KEY`;
    if (process.env[envVar]) routeCfg.apiKey = process.env[envVar];
  }
})();

// ---------------------------------------------------------------
// External classification prompt (ROUTES.md)
// Borrowed from alexrudloff/llmrouter — lets you tweak the triage
// prompt without touching code. Falls back to built-in prompt.
// ---------------------------------------------------------------

let routesTemplate = null;
try {
  if (fs.existsSync(ROUTES_PATH)) {
    routesTemplate = fs.readFileSync(ROUTES_PATH, "utf8");
    console.log(`[router] loaded routes template from ${ROUTES_PATH}`);
  }
} catch (_) { /* ignore */ }

function buildTriagePrompt(userText, sysSnippet, contextSummary) {
  // If ROUTES.md exists and contains {MESSAGE}, use it as the base.
  // Otherwise fall back to the built-in JSON-based triage prompt.
  if (routesTemplate && routesTemplate.includes("{MESSAGE}")) {
    const truncated = userText.length > 500 ? userText.slice(0, 500) + "..." : userText;
    // ROUTES.md's own examples document a "Context: X\n---\nMessage: Y" input
    // shape for follow-ups — build that shape when we have prior context,
    // instead of just substituting {MESSAGE} on its own.
    const messageBlock = contextSummary
      ? `Context: ${contextSummary}\n---\nMessage: ${truncated}`
      : truncated;
    let prompt = routesTemplate.replace("{MESSAGE}", messageBlock);
    if (sysSnippet) {
      prompt += `\n\nSystem context (summarized):\n${sysSnippet}`;
    }
    return { format: "keyword", prompt };
  }
  // Built-in JSON triage prompt (original behavior)
  return {
    format: "json",
    prompt: null, // built inline in triage()
  };
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return; // already rejecting; drain the rest
      total += c.length;
      if (maxBytes && total > maxBytes) {
        tooLarge = true;
        chunks = [];
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        const buf = Buffer.concat(chunks);
        resolve(buf.length ? JSON.parse(buf.toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sessionKey(body) {
  const sys = typeof body.system === "string" ? body.system : JSON.stringify(body.system || "");
  const firstUserMsg = (body.messages || []).find((m) => m.role === "user");
  const seed = sys.slice(0, 500) + JSON.stringify(firstUserMsg || {}).slice(0, 500);
  return crypto.createHash("sha1").update(seed).digest("hex");
}

// LRU-ish cap on sessionBackend: evict the oldest entry when
// the map exceeds MAX_SESSIONS to prevent unbounded memory growth.
function setSession(key, decision) {
  sessionBackend.set(key, decision);
  if (sessionBackend.size > MAX_SESSIONS) {
    const oldest = sessionBackend.keys().next().value;
    sessionBackend.delete(oldest);
  }
}

// Extract text from the most recent user turn. Also returns
// isToolResultOnly so agentic continuations can reuse sticky backend.
function extractLastUserTurn(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;

    if (typeof m.content === "string") {
      return { text: m.content, isToolResultOnly: false, index: i };
    }
    if (Array.isArray(m.content)) {
      const textBlocks = m.content.filter((b) => b.type === "text").map((b) => b.text);
      const hasToolResult = m.content.some((b) => b.type === "tool_result");
      const text = textBlocks.join("\n").trim();
      return {
        text,
        isToolResultOnly: hasToolResult && text.length === 0,
        index: i,
      };
    }
    return { text: "", isToolResultOnly: false, index: i };
  }
  return { text: "", isToolResultOnly: false, index: -1 };
}

// Build a short context summary from recent assistant messages.
// This is the "context inheritance" pattern from alexrudloff/llmrouter:
// short follow-ups like "yes" or "try now?" should inherit the
// complexity of the ongoing task, not be classified as super_easy.
function extractContextSummary(messages, maxChars = 300) {
  const recent = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0 && total < maxChars; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      let text = "";
      if (typeof m.content === "string") text = m.content;
      else if (Array.isArray(m.content)) {
        text = m.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
      }
      if (text) {
        recent.unshift(text.slice(0, maxChars));
        total += text.length;
      }
    }
  }
  return recent.join(" | ").slice(0, maxChars);
}

function wordCount(s) {
  return (s.match(/\S+/g) || []).length;
}

// Detect OAuth tokens (sk-ant-oat*) from alexrudloff/llmrouter
function isOAuthToken(apiKey) {
  return apiKey && apiKey.includes("sk-ant-oat");
}

// Resolve the complexity level, applying tool-aware bumping.
function applyToolFloor(complexity) {
  if (!TOOLS_MIN_COMPLEXITY) return complexity;
  const currentIdx = COMPLEXITY_LEVELS.indexOf(complexity);
  const floorIdx = COMPLEXITY_LEVELS.indexOf(TOOLS_MIN_COMPLEXITY);
  if (currentIdx < 0 || floorIdx < 0) return complexity;
  return currentIdx < floorIdx ? TOOLS_MIN_COMPLEXITY : complexity;
}

// ---------------------------------------------------------------
// Backend call (supports Anthropic Messages API + Ollama local)
// ---------------------------------------------------------------

async function callBackend(backend, body, { stream, timeoutMs } = {}) {
  const baseUrl = backend.baseUrl.replace(/\/$/, "");

  // Detect Ollama local backend (no API key needed, different format)
  if (backend.provider === "ollama" || baseUrl.includes("11434")) {
    return callOllamaBackend(backend, body, timeoutMs);
  }

  // Standard Anthropic Messages API call
  const url = `${baseUrl}/v1/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || UPSTREAM_TIMEOUT_MS);

  const headers = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    ...(backend.extraHeaders || {}),
  };

  // Use x-api-key or Authorization: Bearer depending on token type
  if (isOAuthToken(backend.apiKey)) {
    headers["authorization"] = `Bearer ${backend.apiKey}`;
    headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
    headers["user-agent"] = "claude-cli/2.1.2 (external, cli)";
    headers["x-app"] = "cli";
  } else {
    headers["x-api-key"] = backend.apiKey;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Ollama local backend (from alexrudloff/llmrouter pattern)
// Converts Anthropic Messages API format to Ollama chat format.
async function callOllamaBackend(backend, body, timeoutMs) {
  const url = backend.baseUrl.replace(/\/$/, "") + "/api/chat";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || UPSTREAM_TIMEOUT_MS);

  // Convert Anthropic messages → Ollama format
  const ollamaMessages = [];
  if (body.system) {
    const sysText = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    ollamaMessages.push({ role: "system", content: sysText });
  }
  for (const msg of body.messages || []) {
    let content = "";
    if (typeof msg.content === "string") content = msg.content;
    else if (Array.isArray(msg.content)) {
      content = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
    ollamaMessages.push({ role: msg.role, content });
  }

  const ollamaBody = {
    model: backend.model,
    messages: ollamaMessages,
    stream: !!body.stream,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ollamaBody),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------
// Classifier call (supports Anthropic API + Ollama local)
// ---------------------------------------------------------------

async function callClassifier(payload) {
  const backend = config.classifier;
  const baseUrl = backend.baseUrl.replace(/\/$/, "");

  // Local Ollama classifier (free, from alexrudloff/llmrouter)
  if (backend.provider === "ollama" || baseUrl.includes("11434")) {
    const ollamaUrl = baseUrl + "/api/generate";
    // /api/generate has no system field — flatten payload.system into the
    // prompt. Without it the model never sees the JSON schema instructions
    // (they live in `system` for the built-in JSON prompt), replies
    // freeform, and triage silently falls back to medium on every request.
    const sysText = Array.isArray(payload.system)
      ? payload.system.map((b) => b.text || "").join("\n")
      : typeof payload.system === "string"
        ? payload.system
        : "";
    const prompt = (sysText ? sysText + "\n\n" : "") + payload.messages[0].content;
    const ollamaPayload = {
      model: backend.model,
      prompt,
      stream: false,
      options: { temperature: 0, num_predict: 300 },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(ollamaUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ollamaPayload),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
      const data = await res.json();
      return data.response || "";
    } finally {
      clearTimeout(timer);
    }
  }

  // Remote classifier (Anthropic Messages API)
  const url = `${baseUrl}/v1/messages`;
  const headers = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (isOAuthToken(backend.apiKey)) {
    headers["authorization"] = `Bearer ${backend.apiKey}`;
  } else {
    headers["x-api-key"] = backend.apiKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`classifier HTTP ${res.status}`);
    const data = await res.json();
    return (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------
// Triage: classify complexity + clarity
// ---------------------------------------------------------------

async function triage(userText, systemPrompt, contextSummary) {
  const sysSnippet = typeof systemPrompt === "string"
    ? systemPrompt.slice(0, 800)
    : JSON.stringify(systemPrompt || "").slice(0, 800);

  const { format } = buildTriagePrompt(userText, sysSnippet, contextSummary);

  // --- Keyword-format triage (from ROUTES.md / alexrudloff pattern) ---
  if (format === "keyword") {
    const { prompt } = buildTriagePrompt(userText, sysSnippet, contextSummary);
    try {
      const resultText = await callClassifier({
        model: config.classifier.model,
        max_tokens: 50,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      });
      const complexity = extractComplexityKeyword(resultText);
      // No clarity/assumptions in keyword mode — just complexity
      return { complexity, clarity: "clear", assumptions: [] };
    } catch (e) {
      console.warn(`[router] triage failed, defaulting to medium/clear: ${e.message}`);
      return { complexity: "medium", clarity: "clear", assumptions: [] };
    }
  }

  // --- JSON-format triage (original behavior, enhanced with context) ---
  const contextBlock = contextSummary
    ? `\nRecent assistant context:\n${contextSummary}\n`
    : "";

  const triageBody = {
    model: config.classifier.model,
    max_tokens: 300,
    temperature: 0,
    system:
      "You are a fast triage step in front of a coding assistant. " +
      "Given the user's latest message, respond with ONLY a JSON object " +
      '(no prose, no markdown fences) of the form:\n' +
      '{"complexity":"super_easy"|"easy"|"medium"|"hard"|"super_hard","clarity":"clear"|"ambiguous","assumptions":["..."]}\n\n' +
      '- "complexity":"super_easy" = greetings, acknowledgments, yes/no, single words\n' +
      '- "complexity":"easy" = simple questions, reminders, status checks, formatting\n' +
      '- "complexity":"medium" = write code, email, research, fix bug, any code generation\n' +
      '- "complexity":"hard" = refactor, debug crash, multi-file change, complex code\n' +
      '- "complexity":"super_hard" = design system/architecture, proofs, algorithms, agentic tasks\n\n' +
      "RULE: short follow-ups + complex context = use context complexity (don't downgrade)\n" +
      'RULE: "design" = super_hard, "refactor" = hard\n\n' +
      '- "clarity":"ambiguous" means the request is underspecified enough that a reasonable ' +
      "assistant would have to guess important details. " +
      "Only mark ambiguous if it would genuinely change the work.\n" +
      '- "assumptions": if clarity is "ambiguous", list 1-4 short, concrete assumptions ' +
      "(as plain statements, not questions). " +
      'Empty array if clarity is "clear".',
    messages: [
      {
        role: "user",
        content:
          `System context (summarized):\n${sysSnippet || "none"}\n` +
          contextBlock +
          `\nLatest user message to classify:\n\n${userText}`,
      },
    ],
  };

  try {
    const raw = await callClassifier(triageBody);
    const cleaned = raw.replace(/^```json\s*|^```\s*|```$/gm, "").trim();
    const parsed = JSON.parse(cleaned);
    const complexity = COMPLEXITY_LEVELS.includes(parsed.complexity)
      ? parsed.complexity
      : "medium";
    return {
      complexity,
      clarity: parsed.clarity === "ambiguous" ? "ambiguous" : "clear",
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.slice(0, 4) : [],
    };
  } catch (e) {
    console.warn(`[router] triage failed, defaulting to medium/clear: ${e.message}`);
    return { complexity: "medium", clarity: "clear", assumptions: [] };
  }
}

// Extract complexity from keyword-style responses (super_easy, easy, etc.)
function extractComplexityKeyword(text) {
  const cleaned = text.toLowerCase().replace(/<think>.*?<\/think>/gs, "").trim();
  // Exact match first
  if (COMPLEXITY_LEVELS.includes(cleaned)) return cleaned;
  // Word boundary match (check super_ variants first to avoid partial matches)
  for (const level of ["super_hard", "super_easy", "hard", "medium", "easy"]) {
    if (new RegExp(`\\b${level}\\b`).test(cleaned)) return level;
  }
  // Legacy 2-tier keywords
  if (/\bheavy\b/.test(cleaned)) return "hard";
  if (/\blight\b/.test(cleaned)) return "easy";
  return "medium"; // safe default
}

// ---------------------------------------------------------------
// Clarification note append
// ---------------------------------------------------------------

function appendClarificationNote(messages, userIndex, assumptions) {
  const note =
    "\n\n[router auto-clarification — your request looked underspecified, " +
    "proceeding with these assumptions unless you say otherwise:\n" +
    assumptions.map((a) => `- ${a}`).join("\n") +
    "]";

  const msg = messages[userIndex];
  if (typeof msg.content === "string") {
    msg.content = msg.content + note;
  } else if (Array.isArray(msg.content)) {
    msg.content = [...msg.content, { type: "text", text: note.trim() }];
  }
}

// ---------------------------------------------------------------
// Proxy auth check
// ---------------------------------------------------------------

function checkAuth(req) {
  if (!ROUTER_TOKEN) return true; // auth not configured
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  return token === ROUTER_TOKEN;
}

// ---------------------------------------------------------------
// Resolve route config for a complexity level
// Supports both 5-tier and legacy 2-tier config.
// ---------------------------------------------------------------

function resolveRoute(complexity) {
  // Direct match in config.routes
  if (config.routes[complexity]) return config.routes[complexity];

  // Legacy 2-tier mapping: complexity value -> light/heavy route
  const legacyRoute = LEGACY_COMPLEXITY_TO_TIER[complexity];
  if (legacyRoute && config.routes[legacyRoute]) {
    return config.routes[legacyRoute];
  }

  // Fallback chain: try nearby tiers, then light/heavy, then first route
  const idx = COMPLEXITY_LEVELS.indexOf(complexity);
  for (let offset = 1; offset < COMPLEXITY_LEVELS.length; offset++) {
    for (const dir of [-1, 1]) {
      const neighbor = COMPLEXITY_LEVELS[idx + offset * dir];
      if (neighbor && config.routes[neighbor]) return config.routes[neighbor];
    }
  }
  // Legacy fallback
  if (config.routes.light) return config.routes.light;
  if (config.routes.heavy) return config.routes.heavy;
  // Last resort: first route in config
  return Object.values(config.routes)[0];
}

// ---------------------------------------------------------------
// Server
// ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // Proxy auth gate
  if (!checkAuth(req)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("claude-smart-router is running\n");
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        uptimeSeconds: Math.floor(process.uptime()),
        sessions: sessionBackend.size,
      })
    );
    return;
  }

  if (req.method !== "POST" || req.url !== "/v1/messages") {
    // Passthrough anything else to the default backend, best-effort.
    try {
      const backend = resolveRoute("easy");
      const headers = {
        "x-api-key": backend.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        headers["content-type"] = "application/json";
      }
      const bodyChunks = [];
      if (req.method !== "GET" && req.method !== "HEAD") {
        await new Promise((resolve, reject) => {
          let total = 0;
          let tooLarge = false;
          req.on("data", (c) => {
            if (tooLarge) return;
            total += c.length;
            if (total > MAX_BODY_BYTES) {
              tooLarge = true;
              reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
              return;
            }
            bodyChunks.push(c);
          });
          req.on("end", resolve);
          req.on("error", reject);
        });
      }
      const upstream = await fetch(
        `${backend.baseUrl.replace(/\/$/, "")}${req.url}`,
        {
          method: req.method,
          headers,
          body: bodyChunks.length ? Buffer.concat(bodyChunks) : undefined,
        }
      );
      // Strip hop-by-hop / encoding headers: fetch() already transparently
      // decompresses gzip/deflate bodies, so forwarding the original
      // content-encoding or content-length would make the client try to
      // decode an already-decoded body.
      const DROP_HEADERS = new Set([
        "content-encoding", "content-length", "transfer-encoding", "connection",
      ]);
      const respHeaders = {};
      upstream.headers.forEach((v, k) => {
        if (!DROP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v;
      });
      res.writeHead(upstream.status, respHeaders);
      if (upstream.body) {
        const readable = Readable.fromWeb(upstream.body);
        readable.on("error", (e) => {
          console.error(`[router] passthrough stream error: ${e.message}`);
          if (!res.writableEnded) res.end();
        });
        readable.pipe(res);
      } else {
        res.end(await upstream.text());
      }
    } catch (e) {
      const status = e.statusCode === 413 ? 413 : 502;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.statusCode === 413 ? `request body exceeds ${MAX_BODY_BYTES} bytes` : e.message }));
    }
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    const status = e.statusCode === 413 ? 413 : 400;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.statusCode === 413 ? `request body exceeds ${MAX_BODY_BYTES} bytes` : "invalid JSON body" }));
    return;
  }

  // Deep-clone body so that any mutation never affects a retry.
  body = JSON.parse(JSON.stringify(body));

  const key = sessionKey(body);
  const { text, isToolResultOnly, index } = extractLastUserTurn(body.messages || []);
  const contextSummary = extractContextSummary(body.messages || []);

  // Detect if request includes tools (from alexrudloff/llmrouter)
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // NOTE: when inheriting a decision from a prior turn (continuation or
  // short follow-up), we always build a *new* object with assumptions: [].
  // Two reasons:
  //  1. Reusing the stored object by reference would let later mutations
  //     (e.g. the tool-floor bump below) silently rewrite session history.
  //  2. The clarification note was already shown to the model on the turn
  //     that generated it — re-appending it on every later turn is noise,
  //     and on tool-result-only turns it doesn't even attach to real user
  //     text, it just gets bolted onto unrelated tool output.
  let decision;
  let classifiedComplexity; // pre-floor value; what the session stores
  if (isToolResultOnly && sessionBackend.has(key)) {
    // Agentic continuation — inherit complexity only, not assumptions.
    const prior = sessionBackend.get(key);
    decision = { complexity: prior.complexity, assumptions: [] };
    classifiedComplexity = prior.complexity;
    console.log(`[router] continuation -> sticking with ${decision.complexity}`);
  } else if (!text || wordCount(text) < MIN_WORDS_TO_CLASSIFY) {
    // Too short to classify — but check if session has context to inherit.
    if (sessionBackend.has(key) && contextSummary) {
      const prior = sessionBackend.get(key);
      decision = { complexity: prior.complexity, assumptions: [] };
      classifiedComplexity = prior.complexity;
      console.log(`[router] short follow-up -> inheriting ${decision.complexity} from session context`);
    } else {
      decision = { complexity: "super_easy", assumptions: [] };
      classifiedComplexity = "super_easy";
    }
  } else {
    const t = await triage(text, body.system, contextSummary);
    decision = { complexity: t.complexity, assumptions: t.clarity === "ambiguous" ? t.assumptions : [] };
    classifiedComplexity = t.complexity;
    console.log(
      `[router] complexity=${t.complexity} clarity=${t.clarity}` +
        (t.assumptions.length ? ` assumptions=${JSON.stringify(t.assumptions)}` : "")
    );
  }

  // Tool-aware complexity bumping (from alexrudloff/llmrouter).
  // The floor is a per-turn guardrail (tools may be attached this turn and
  // absent the next), so the bump applies to ROUTING only — the session
  // stores the classified value, and later turns inherit what the classifier
  // actually decided, not a floor that no longer applies to them.
  if (hasTools) {
    const original = decision.complexity;
    decision.complexity = applyToolFloor(decision.complexity);
    if (decision.complexity !== original) {
      console.log(`[router] tools present -> bumped complexity ${original} → ${decision.complexity}`);
    }
  }

  setSession(key, { complexity: classifiedComplexity, assumptions: decision.assumptions });

  if (CLARIFY_ENABLED && decision.assumptions && decision.assumptions.length && index >= 0) {
    appendClarificationNote(body.messages, index, decision.assumptions);
  }

  // Resolve backend: check for tools-fixed-model override, then normal routing
  let backend;
  if (hasTools && TOOLS_FIXED_MODEL) {
    // Find the route that has the fixed model, or build a synthetic one
    backend = Object.values(config.routes).find((r) => r.model === TOOLS_FIXED_MODEL);
    if (!backend) {
      // Build a synthetic backend using the default base URL + the fixed model
      const defaultRoute = resolveRoute(decision.complexity);
      backend = { ...defaultRoute, model: TOOLS_FIXED_MODEL };
    }
    console.log(`[router] tools -> forcing model=${TOOLS_FIXED_MODEL}`);
  } else {
    backend = resolveRoute(decision.complexity);
  }

  const requestedModel = body.model;
  body.model = backend.model;

  const costWeight = COST_WEIGHTS[decision.complexity] || 1.0;
  console.log(
    `[router] -> complexity=${decision.complexity} requested_model=${requestedModel || "n/a"} ` +
    `routed_model=${backend.model} cost_weight=${costWeight}`
  );

  try {
    const upstream = await callBackend(backend, body, { stream: !!body.stream });

    const headers = { "content-type": upstream.headers.get("content-type") || "application/json" };
    res.writeHead(upstream.status, headers);

    if (upstream.body) {
      const readable = Readable.fromWeb(upstream.body);
      readable.on("error", (e) => {
        console.error(`[router] upstream stream error: ${e.message}`);
        if (!res.writableEnded) res.end();
      });
      readable.pipe(res);
    } else {
      res.end(await upstream.text());
    }
  } catch (e) {
    console.error(`[router] upstream error: ${e.message}`);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `router: upstream call failed: ${e.message}` }));
  }
});

// ---------------------------------------------------------------
// Startup
// ---------------------------------------------------------------

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(`[router] listening on http://${displayHost}:${PORT} (bind: ${HOST})`);

  if (config.__usingDefaults) {
    console.log(`[router] using bundled default config (${config.__configPath}) — GLM tiers, port ${PORT}.`);
    console.log(`[router] drop a config.json in ${process.cwd()} to customize.`);
  }

  // Log all configured routes
  for (const [name, route] of Object.entries(config.routes)) {
    console.log(`[router] ${name} -> ${route.model} @ ${route.baseUrl}`);
  }

  console.log(`[router] classifier -> ${config.classifier.model} @ ${config.classifier.baseUrl}`);
  console.log(`[router] clarify=${CLARIFY_ENABLED}`);
  console.log(`[router] upstreamTimeout=${UPSTREAM_TIMEOUT_MS}ms maxSessions=${MAX_SESSIONS} maxBody=${(MAX_BODY_BYTES / (1024 * 1024)).toFixed(0)}MB`);
  console.log(`[router] tools.minComplexity=${TOOLS_MIN_COMPLEXITY}` +
    (TOOLS_FIXED_MODEL ? ` tools.model=${TOOLS_FIXED_MODEL}` : ""));

  // Key audit: a route without any resolvable key fails every request
  // with an upstream 401 — better to name it at startup. Ollama
  // backends (no auth) are exempt. Placeholder-looking values count as
  // missing, since they'd 401 identically.
  const PLACEHOLDER_RE = /^(PASTE_|your_|xxx+$|test-)/i;
  const looksPlaceholder = (v) => !v || PLACEHOLDER_RE.test(v);
  const keyIssues = [];
  const routeKeySources = [];
  for (const [name, route] of Object.entries(config.routes)) {
    const isOllama = route.provider === "ollama" || (route.baseUrl || "").includes("11434");
    if (isOllama) continue;
    const hasKey = !looksPlaceholder(route.apiKey);
    if (!hasKey) keyIssues.push(`route "${name}" (${route.model}) has no API key`);
    routeKeySources.push([name, hasKey]);
  }
  const classifier = config.classifier;
  if (classifier && !(classifier.provider === "ollama" || (classifier.baseUrl || "").includes("11434"))) {
    if (looksPlaceholder(classifier.apiKey)) {
      keyIssues.push(`classifier (${classifier.model}) has no API key`);
    }
  }
  if (keyIssues.length) {
    console.warn(`[router] WARNING: ${keyIssues.length} backend${keyIssues.length > 1 ? "s" : ""} will reject every request:`);
    for (const issue of keyIssues) console.warn(`[router]   - ${issue}`);
    console.warn(`[router] Fix: claude-smart-router key set route   (or ROUTE_API_KEY / .env / per-route apiKey in config)`);
    if (keyIssues.some((i) => i.startsWith("classifier"))) {
      console.warn(`[router]       claude-smart-router key set classifier`);
    }
  }

  if (ROUTER_TOKEN) console.log(`[router] proxyAuth=enabled`);
  else console.log(`[router] proxyAuth=disabled (set routerToken in config or ROUTER_TOKEN env to enable)`);

  if (routesTemplate) console.log(`[router] routesTemplate=ROUTES.md (keyword mode)`);
  else console.log(`[router] routesTemplate=built-in (JSON mode)`);
});

// A second instance on the same port is almost always a stale process —
// give the actionable hint instead of a bare stack trace.
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n[router] Port ${PORT} is already in use — another router instance running?\n`);
    process.exit(1);
  }
  console.error(`[router] server error: ${e.message}`);
  process.exit(1);
});

// Graceful shutdown: stop accepting new connections, let in-flight
// streams finish, exit. Forces after 10s if something hangs.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[router] ${signal} received — shutting down...`);
  server.close(() => {
    console.log("[router] closed.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[router] forced exit after 10s — some connections did not close.");
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
