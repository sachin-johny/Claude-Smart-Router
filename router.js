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

// Debug mode: per-request trace — prompt preview, classifier reply, and
// the upstream URL/status the request actually went to. Enable with
// "debug": true in config.json or DEBUG=1 env var.
const DEBUG =
  config.debug === true ||
  ["1", "true", "yes"].includes((process.env.DEBUG || "").toLowerCase());

function debugLog(...args) {
  if (DEBUG) console.log("[router:debug]", ...args);
}

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

// ---------------------------------------------------------------
// Repository map (per-session project overview)
// ---------------------------------------------------------------
// Injects a compact file-tree + exports summary into the FIRST user
// message of every request in a session, so the model knows what
// project it's in without the user having to @-mention files.
//
// The Messages API is stateless: the client owns the history and
// resends its clean copy every request, so a one-shot mutation would
// be seen by exactly ONE model call. Instead the payload is FROZEN
// per session at the first turn whose classified complexity clears
// minComplexity, and the same frozen bytes are re-appended on every
// subsequent request. Byte-identical re-injection means the injected
// prefix never changes -> upstream prompt caching covers it, so later
// turns pay cache-read price (~10%) for the map, not full price.
//
// The map cache itself is TTL-based (see REPO_MAP_TTL_MS); rebuilds
// and POST /map/refresh affect only sessions frozen afterward —
// freezing never rewrites a live session's bytes (that would break
// the cache prefix on every turn the map changed).
//
// Config (config.json):
//   "repoMap": {
//     "enabled": true,            // default true
//     "root": "./",               // default cwd; override via ROUTER_PROJECT_ROOT
//     "maxTokens": 2000,          // ~4 chars/token, hard byte cap
//     "minComplexity": "medium"   // skip until a turn classifies at/above this
//   }
const REPO_MAP_ENABLED = config.repoMap?.enabled !== false;
const REPO_MAP_ROOT = process.env.ROUTER_PROJECT_ROOT || config.repoMap?.root || process.cwd();
const REPO_MAP_MAX_TOKENS = config.repoMap?.maxTokens || 2000;
// Gate on the CLASSIFIED (pre-tool-floor) complexity: Claude Code sends
// tools on every request, so the tool floor would bump everything to
// >= medium and a post-floor gate would never block real traffic.
let REPO_MAP_MIN_COMPLEXITY = config.repoMap?.minComplexity || "medium";
if (!COMPLEXITY_LEVELS.includes(REPO_MAP_MIN_COMPLEXITY)) {
  console.warn(
    `[router] repoMap: invalid minComplexity "${REPO_MAP_MIN_COMPLEXITY}" ` +
    `(expected one of ${COMPLEXITY_LEVELS.join(", ")}) — falling back to "medium"`
  );
  REPO_MAP_MIN_COMPLEXITY = "medium";
}
// How long the cached map stays fresh before rebuild-on-access. VS Code
// saves + Claude Code round-trips are almost always slower than this, so
// by the time a new session starts the cache has already expired and the
// rebuild picks up file additions / deletions. Trade-off: lower = fresher
// but more walks; higher = fewer walks but staler after big edits.
// 10s is the sweet spot — walks are <100ms for typical projects.
const REPO_MAP_TTL_MS = config.repoMap?.ttlMs || 10_000;
// Specific files to inject alongside the map. Useful for project context
// that Claude Code doesn't auto-load (CLAUDE.md is already auto-loaded by
// Claude Code, so don't duplicate it here). Each file is capped at
// REPO_MAP_PINNED_MAX_BYTES to prevent budget blowup. Paths are relative
// to REPO_MAP_ROOT; non-existent / unreadable files are silently skipped.
const REPO_MAP_PINNED_FILES = Array.isArray(config.repoMap?.pinnedFiles)
  ? config.repoMap.pinnedFiles.slice(0, 10)
  : [];
const REPO_MAP_PINNED_MAX_BYTES = 8 * 1024; // 8KB per file — generous for READMEs, tight enough to block runaway config

// Auto-compact: after N *text* user turns (see countUserTextTurns — tool
// round-trips don't count), inject the one-liner variant of the map
// ("15 files, key: main.js, util.js, ...") instead of the full tree.
// The router cannot trigger Claude Code's /compact (that's client-side);
// this shrinks the router's OWN injected content once the model has
// already Read the files it needs. Switching variants rewrites the
// injected prefix exactly once (one cache break), then the compact
// bytes are just as stable as the full ones.
//
// Threshold is frozen per session at freeze time (the session's classified
// complexity on the turn that froze the map), so it can't flip-flop if a
// later follow-up classifies differently. Set a tier to 0 to disable
// compaction for it.
const REPO_MAP_COMPACT_AFTER = Object.assign(
  { super_hard: 4, hard: 5, medium: 6 },
  config.repoMap?.compactAfter || {}
);

// Optional: write the map to a file on each rebuild, so the user can
// @include it in CLAUDE.md for every-turn visibility. Trade-off: a
// CLAUDE.md include is charged at full input price every turn, while
// router injection sits inside the cached prefix (~10% per turn after
// the first write). If you @include the file in CLAUDE.md, set
// repoMap.enabled=false to avoid paying for the map twice.
// Path is relative to REPO_MAP_ROOT.
const REPO_MAP_WRITE_TO_FILE = config.repoMap?.writeToFile || null;

// Cost weights per tier (from ulab-uiuc/LLMRouter cost-aware concept).
// Used for logging only in this proxy — extend if you want budget enforcement.
const COST_WEIGHTS = config.costWeights || {
  super_easy: 0.05,
  easy: 0.15,
  medium: 0.40,
  hard: 0.70,
  super_hard: 1.00,
};

// Budget enforcement: track cumulative cost per session.
// If budgetMax is set in config, sessions exceeding it get downgraded
// to the cheapest tier (or rejected if budgetReject=true).
const BUDGET_MAX = config.budgetMax ?? null;     // e.g. 10.0 = 10x medium-equivalent
const BUDGET_REJECT = config.budgetReject ?? false; // true = 429 on budget breach
const sessionBudget = new Map(); // key -> { cumulative, breachedAt }

function addSessionCost(key, costWeight) {
  const entry = sessionBudget.get(key) || { cumulative: 0, breachedAt: null };
  entry.cumulative += costWeight;
  if (BUDGET_MAX && entry.cumulative >= BUDGET_MAX && !entry.breachedAt) {
    entry.breachedAt = Date.now();
    console.warn(`[router] budget: session ${key.slice(0,10)} hit budget cap (${entry.cumulative.toFixed(2)} >= ${BUDGET_MAX})`);
  }
  sessionBudget.set(key, entry);
  return entry;
}

// Failure-based auto-escalation: if a cheap tier produces obviously
// broken output (empty, malformed tool calls, error messages), retry
// on the next-higher tier. Capped at 1 escalation per session to
// prevent loops.
const FAILURE_PATTERNS = [
  /error:\s*(tool_use|tool_result|invalid|malformed)/i,
  /i cannot (?:complete|fulfill|perform|execute)/i,
  /(?:failed|unable) to (?:parse|execute|run|call)/i,
  /tool_use.*malformed/i,
];
const MAX_ESCALATIONS_PER_SESSION = 1;
const sessionEscalations = new Map(); // key -> count

// Compaction hint: the router can't call Claude Code's /compact directly
// (it's a client-side CLI command), but it CAN inject a one-time hint
// into the conversation when it's getting long. The model then surfaces
// this to the user. Configurable threshold; set compactHintTurns to 0
// to disable.
const COMPACT_HINT_TURNS = config.compactHintTurns ?? 15;
const sessionCompactedHint = new Map(); // key -> true (hinted already)

// ---------------------------------------------------------------
// Sticky session map: lets us skip re-classifying tool-result
// continuations AND lets short follow-ups inherit context complexity
// (from alexrudloff/llmrouter's context-inheritance pattern).
// ---------------------------------------------------------------

const sessionBackend = new Map();

// ---------------------------------------------------------------
// Classification cache: avoid re-classifying identical prompts
// Keyed by hash of (userText + contextSummary), TTL-based.
// A short TTL (60s) balances freshness vs. classifier call savings.
// ---------------------------------------------------------------

const CLASSIFY_CACHE_TTL_MS = config.classifyCacheTtlMs ?? 60_000;
const classifyCache = new Map();

function getCachedClassification(cacheKey) {
  if (CLASSIFY_CACHE_TTL_MS <= 0) return null; // caching disabled
  const entry = classifyCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.ts > CLASSIFY_CACHE_TTL_MS) {
    classifyCache.delete(cacheKey);
    return null;
  }
  return entry.result;
}

function setCachedClassification(cacheKey, result) {
  if (CLASSIFY_CACHE_TTL_MS <= 0) return; // caching disabled
  classifyCache.set(cacheKey, { result, ts: Date.now() });
  // Cap cache size (LRU-ish: delete oldest)
  if (classifyCache.size > 500) {
    const oldest = classifyCache.keys().next().value;
    classifyCache.delete(oldest);
  }
}

// ---------------------------------------------------------------
// GLM Coding Plan credit tracking (docs.z.ai/devpack/overview).
//
// Tracks REAL plan credits — computed from the usage object upstream
// reports on every response, never estimated — against the two plan
// windows:
//   5-hour: sliding; credits replenish 5h after they were spent.
//   weekly: anchored cycle; resets every 7 days from weeklyResetAnchor.
// Off-peak hours bill at 0.5x (peak = Mon-Fri 14:00-18:00 SGT/UTC+8).
//
// Known blind spot: anything that bypasses the router (Z.AI MCP tools
// like web search, other API clients) is invisible here — treat the
// numbers as a lower bound on plan usage.
// ---------------------------------------------------------------

const CREDITS_CFG = config.credits || {};
const CREDITS_ENABLED = CREDITS_CFG.enabled !== false;
const PLAN_CAP_PRESETS = {
  lite: { fiveHour: 2000, weekly: 10000 },
  pro: { fiveHour: 12000, weekly: 60000 },
  max: { fiveHour: 28000, weekly: 140000 },
};
const CREDIT_CAPS =
  CREDITS_CFG.caps || PLAN_CAP_PRESETS[String(CREDITS_CFG.plan || "").toLowerCase()] || PLAN_CAP_PRESETS.lite;
const CREDITS_WARN_PCT = CREDITS_CFG.warnPct ?? 80;
const CREDITS_HINTS = CREDITS_CFG.hints !== false;
const CREDITS_PEAK_HINT = CREDITS_CFG.peakHint !== false;

// Credit multipliers per Z.AI docs (per 10k tokens). Config may override
// or extend per model. glm-5.2/glm-5.1 alias 5.3: upstream auto-routes
// those requests to 5.3, so they bill as 5.3.
const DEFAULT_CREDIT_MODELS = {
  "glm-5.3": { in: 6.9, cached: 1.7, out: 24 },
  "glm-5.2": { in: 6.9, cached: 1.7, out: 24 },
  "glm-5.1": { in: 6.9, cached: 1.7, out: 24 },
  "glm-5-turbo": { in: 5.7, cached: 1.5, out: 21 },
  "glm-4.7": { in: 4.6, cached: 1.2, out: 16 },
};
const CREDIT_MODELS = { ...DEFAULT_CREDIT_MODELS, ...(CREDITS_CFG.multipliers || {}) };

function creditMultipliersFor(model) {
  const norm = String(model || "").toLowerCase();
  if (CREDIT_MODELS[norm]) return CREDIT_MODELS[norm];
  // Prefix match: glm-5.3-air bills at glm-5.3 rates
  for (const [name, mult] of Object.entries(CREDIT_MODELS)) {
    if (norm.startsWith(name)) return mult;
  }
  return null; // non-GLM model — not plan-billed, skip
}

// Peak hours per docs: Mon-Fri 14:00-18:00 Singapore time. SGT is a
// fixed UTC+8 offset (no DST), so pure epoch math works regardless of
// the host timezone — a German host in CET/CEST needs no conversion
// tables. Wall clock trick: shift the epoch, read via getUTC*.
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
function peakState(now) {
  const sgt = new Date(now + SGT_OFFSET_MS);
  const day = sgt.getUTCDay(); // 0=Sun .. 6=Sat
  const mins = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 14 * 60 && mins < 18 * 60;
}
let peakCache = { at: 0, val: false };
function isPeakNow(now = Date.now()) {
  if (Math.abs(now - peakCache.at) < 30_000) return peakCache.val;
  peakCache = { at: now, val: peakState(now) };
  return peakCache.val;
}
// Minutes until the peak/off-peak state flips — for hints and /credits.
function minutesUntilPeakChange(now = Date.now()) {
  const sgt = new Date(now + SGT_OFFSET_MS);
  const mins = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
  const isWeekday = (d) => d >= 1 && d <= 5;
  if (isWeekday(sgt.getUTCDay()) && mins >= 14 * 60 && mins < 18 * 60) {
    return 18 * 60 - mins; // in peak: ends at 18:00 SGT
  }
  // Off-peak/weekend: scan forward for the next weekday 14:00 SGT
  for (let add = 0; add <= 7; add++) {
    const d = new Date(Date.UTC(sgt.getUTCFullYear(), sgt.getUTCMonth(), sgt.getUTCDate() + add));
    if (!isWeekday(d.getUTCDay())) continue;
    const targetMins = add * 24 * 60 + 14 * 60;
    if (targetMins > mins) return targetMins - mins;
  }
  return 0;
}

// Weekly cycle: anchor = a known past reset time (ISO string). Without
// one, fall back to a plain rolling 7-day window — accurate for the
// 5h number, approximate for the weekly one.
const CREDIT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CREDITS_ANCHOR_MS = CREDITS_CFG.weeklyResetAnchor ? Date.parse(CREDITS_CFG.weeklyResetAnchor) : NaN;
function weeklyCycleStart(now = Date.now()) {
  if (!Number.isFinite(CREDITS_ANCHOR_MS)) return now - CREDIT_WEEK_MS;
  // Anchor in the future = first reset hasn't happened yet; the current
  // cycle started (subscription activation) 7 days before it.
  if (CREDITS_ANCHOR_MS > now) return CREDITS_ANCHOR_MS - CREDIT_WEEK_MS;
  return CREDITS_ANCHOR_MS + Math.floor((now - CREDITS_ANCHOR_MS) / CREDIT_WEEK_MS) * CREDIT_WEEK_MS;
}
function weeklyResetAt(now = Date.now()) {
  return weeklyCycleStart(now) + CREDIT_WEEK_MS;
}

// Ledger: append-only {t, c} events, pruned to the weekly cycle (the
// 5h window is contained inside it). Survives restarts via stateFile.
let creditEvents = [];
const creditWarnLevels = { fiveHour: 0, weekly: 0 }; // highest crossed warn level
function warnLevels() {
  const l1 = Math.max(1, Math.min(99, Math.round(CREDITS_WARN_PCT)));
  return [l1, Math.min(99, l1 + 10), 100];
}
function levelForPct(pct) {
  const levels = warnLevels();
  let level = 0;
  for (const pctMark of levels) if (pct >= pctMark) level++;
  return level;
}

function pruneCreditEvents(now = Date.now()) {
  const cutoff = weeklyCycleStart(now);
  if (creditEvents.length && creditEvents[0].t < cutoff) {
    creditEvents = creditEvents.filter((e) => e.t >= cutoff);
  }
}
function creditsUsedSince(cutoff) {
  let sum = 0;
  for (const e of creditEvents) if (e.t >= cutoff) sum += e.c;
  return sum;
}
function creditsSnapshot(now = Date.now()) {
  const cap5h = CREDIT_CAPS.fiveHour || 0;
  const capWk = CREDIT_CAPS.weekly || 0;
  const used5h = creditsUsedSince(now - 5 * 60 * 60 * 1000);
  const usedWk = creditsUsedSince(weeklyCycleStart(now));
  return {
    enabled: CREDITS_ENABLED,
    fiveHour: {
      used: +used5h.toFixed(2),
      cap: cap5h,
      pct: cap5h ? Math.round((used5h / cap5h) * 100) : 0,
    },
    weekly: {
      used: +usedWk.toFixed(2),
      cap: capWk,
      pct: capWk ? Math.round((usedWk / capWk) * 100) : 0,
      // A rolling window (no anchor) has no reset instant — report null
      // rather than a meaningless "resets now".
      ...(Number.isFinite(CREDITS_ANCHOR_MS)
        ? {
            resetsAt: new Date(weeklyResetAt(now)).toISOString(),
            resetsInMin: Math.round((weeklyResetAt(now) - now) / 60000),
          }
        : { resetsAt: null, resetsInMin: null, window: "rolling-7d" }),
    },
    peak: {
      now: isPeakNow(now),
      changeInMin: Math.round(minutesUntilPeakChange(now)),
    },
    events: creditEvents.length,
  };
}

// Book credits for one upstream response. usage = the Anthropic-format
// usage object (input_tokens / cache_read_input_tokens /
// cache_creation_input_tokens / output_tokens). Cache CREATION is fresh
// input, so it bills at the input rate; cache READS bill at the cached
// rate. Off-peak requests (by request START time) bill at 0.5x.
function recordCredits(model, usage, startedAtMs = Date.now()) {
  if (!CREDITS_ENABLED || !usage || typeof usage !== "object") return 0;
  const mult = creditMultipliersFor(model);
  if (!mult) return 0;
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const cached = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  let credits = (input * mult.in + cached * mult.cached + output * mult.out) / 10000;
  if (!peakState(startedAtMs)) credits *= 0.5;
  creditEvents.push({ t: startedAtMs, c: credits });
  pruneCreditEvents();
  scheduleCreditStateSave();
  checkCreditThresholds(startedAtMs);
  return credits;
}

// Console warns fire once per upward threshold crossing (and re-arm if
// the sliding window recedes). Conversation hints are injected later,
// on the session's next request — see maybeInjectCreditHints.
function checkCreditThresholds(now = Date.now()) {
  if (!CREDITS_ENABLED) return;
  const snap = creditsSnapshot(now);
  for (const kind of ["fiveHour", "weekly"]) {
    const level = levelForPct(snap[kind].pct);
    if (level > creditWarnLevels[kind]) {
      creditWarnLevels[kind] = level;
      const s = snap[kind];
      const extra = kind === "weekly" && s.resetsInMin != null ? `, resets in ${Math.round(s.resetsInMin / 60)}h` : "";
      console.warn(
        `[router] credits: ${kind} usage at ${s.pct}% (${s.used} of ${s.cap}${extra})`
      );
    } else if (level < creditWarnLevels[kind]) {
      creditWarnLevels[kind] = level; // window slid back below — re-arm
    }
  }
}

// One-time-per-session conversation hints (same injection pattern as
// the compaction hint). Threshold hints fire on the request AFTER the
// crossing (usage is only known once a response completes); the peak
// hint is known up-front, so it fires on the first request of any
// session during peak hours. At most one hint per request.
function maybeInjectCreditHints(key, firstUserIdx, messages) {
  if (!CREDITS_ENABLED || !CREDITS_HINTS || firstUserIdx < 0) return;
  const done = sessionCreditHints.get(key) || new Set();
  sessionCreditHints.set(key, done);
  const snap = creditsSnapshot();
  const warnPct = warnLevels()[0];
  let hint = null;

  if (!done.has("fiveHour") && snap.fiveHour.pct >= warnPct) {
    hint =
      `[router: ${snap.fiveHour.pct}% of the 5-hour GLM credit window is used ` +
      `(${snap.fiveHour.used} of ${snap.fiveHour.cap} credits). The window replenishes ` +
      `as spend ages out — if the upstream starts throttling, this is why.]`;
    done.add("fiveHour");
  } else if (!done.has("weekly") && snap.weekly.pct >= warnPct) {
    hint =
      `[router: ${snap.weekly.pct}% of the weekly GLM credits are used ` +
      `(${snap.weekly.used} of ${snap.weekly.cap})` +
      (snap.weekly.resetsAt ? ` — quota resets ${new Date(snap.weekly.resetsAt).toLocaleString()}` : "") +
      ` — pace remaining usage accordingly.]`;
    done.add("weekly");
  } else if (!done.has("peak") && CREDITS_PEAK_HINT && snap.peak.now) {
    hint =
      `[router: peak hours (Mon-Fri 14:00-18:00 UTC+8) — GLM credits bill at ` +
      `full rate for the next ~${snap.peak.changeInMin} min; outside peak they cost half.]`;
    done.add("peak");
  }

  if (hint) {
    appendTextToMessage(messages[firstUserIdx], "\n\n" + hint);
    debugLog(`credits: injected ${[...done].pop()} hint into session ${key.slice(0, 10)}`);
  }
}
const sessionCreditHints = new Map(); // sessionKey -> Set(hint kinds already sent)

// Observe a streamed SSE response without interfering with it: a second
// 'data' listener alongside pipe() receives the same chunks. The
// usage-bearing events are message_start (input + cache tokens) and the
// final message_delta (output tokens); credits are booked once the
// stream settles (end/error/close — partial streams still count).
function makeSseUsageScanner(onUsage) {
  let buf = "";
  let input = 0, cacheRead = 0, cacheCreate = 0, output = 0;
  const take = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let ev;
    try { ev = JSON.parse(payload); } catch (_) { return; }
    if (ev.type === "message_start" && ev.message && ev.message.usage) {
      input = ev.message.usage.input_tokens || 0;
      cacheRead = ev.message.usage.cache_read_input_tokens || 0;
      cacheCreate = ev.message.usage.cache_creation_input_tokens || 0;
    } else if (ev.type === "message_delta" && ev.usage) {
      output = ev.usage.output_tokens || output;
    }
  };
  let settled = false;
  return {
    push(chunk) {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        take(buf.slice(0, nl).replace(/\r$/, ""));
        buf = buf.slice(nl + 1);
      }
      if (buf.length > 64 * 1024) buf = buf.slice(-1024); // runaway line safety
    },
    end() {
      if (settled) return;
      settled = true;
      if (buf) take(buf.replace(/\r$/, ""));
      onUsage({
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        output_tokens: output,
      });
    },
  };
}

function trackStreamedUsage(readable, model, startedAtMs) {
  const scanner = makeSseUsageScanner((usage) => recordCredits(model, usage, startedAtMs));
  readable.on("data", (chunk) => scanner.push(chunk));
  readable.on("end", () => scanner.end());
  readable.on("error", () => scanner.end());
  readable.on("close", () => scanner.end());
}

// --- persistence: the weekly window must survive restarts ---
const CREDITS_STATE_FILE = CREDITS_CFG.stateFile !== undefined ? CREDITS_CFG.stateFile : "credits-state.json";
function creditsStatePath() {
  return path.isAbsolute(String(CREDITS_STATE_FILE))
    ? String(CREDITS_STATE_FILE)
    : path.join(path.dirname(CONFIG_PATH), CREDITS_STATE_FILE);
}
let creditSaveTimer = null;
function scheduleCreditStateSave() {
  if (!CREDITS_ENABLED || creditSaveTimer) return;
  creditSaveTimer = setTimeout(() => {
    creditSaveTimer = null;
    saveCreditState();
  }, 3000);
  creditSaveTimer.unref();
}
function saveCreditState() {
  if (!CREDITS_ENABLED) return;
  try {
    pruneCreditEvents();
    const p = creditsStatePath();
    fs.writeFileSync(p + ".tmp", JSON.stringify({ v: 1, events: creditEvents, warnLevels: creditWarnLevels }));
    fs.renameSync(p + ".tmp", p);
  } catch (e) {
    console.warn(`[router] credits: state save failed: ${e.message}`);
  }
}
(function loadCreditState() {
  if (!CREDITS_ENABLED) return;
  try {
    const p = creditsStatePath();
    const st = JSON.parse(fs.readFileSync(p, "utf8"));
    if (Array.isArray(st.events)) {
      creditEvents = st.events.filter((e) => e && Number.isFinite(e.t) && Number.isFinite(e.c));
    }
    if (st.warnLevels) Object.assign(creditWarnLevels, st.warnLevels);
    pruneCreditEvents();
    console.log(`[router] credits: restored ${creditEvents.length} event(s) from ${p}`);
  } catch (_) { /* no state file yet — fine */ }
})();

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

// Index of the session's FIRST user message — the exact predicate
// sessionKey uses above. This is where the repo map is re-injected:
// always the same message, always appended, so the mutated prefix is
// byte-identical across turns (prompt-cache friendly). Injecting into
// the LAST user message would move the map forward every turn.
function firstUserMessageIndex(messages) {
  return (messages || []).findIndex((m) => m.role === "user");
}

// LRU-ish cap on sessionBackend: evict the oldest entry when
// the map exceeds MAX_SESSIONS to prevent unbounded memory growth.
function setSession(key, decision) {
  // Refresh recency: Map.set on an existing key does NOT move it, so
  // without the delete a long-running active session could be evicted
  // (insertion-order) while idle old ones survive — evicting it mid-
  // conversation forces a re-freeze of its repo map (cache break).
  sessionBackend.delete(key);
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

// Count "real" user turns: user messages that carry non-empty text.
// In Claude Code every tool_result round-trip is a role:"user" message,
// so counting all user messages would make a super_hard agentic loop
// cross its compactAfter threshold within ~2 tool calls — right when
// the map is most useful. Tool-result-only messages don't count; a
// message combining tool_result + typed text does (genuine interleaved
// user input).
function countUserTextTurns(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      if (m.content.trim()) n++;
    } else if (Array.isArray(m.content)) {
      if (m.content.some((b) => b.type === "text" && typeof b.text === "string" && b.text.trim())) n++;
    }
  }
  return n;
}

// Build a short context summary from recent assistant messages.
// This is the "context inheritance" pattern from alexrudloff/llmrouter:
// short follow-ups like "yes" or "try now?" should inherit the
// complexity of the ongoing task, not be classified as super_easy.
// Extended context summary: includes recent assistant AND user text turns
// for better classification accuracy. Default 800 chars (up from 300) —
// the classifier is a cheap model; 800 chars is ~200 tokens, trivial cost
// for meaningfully better context inheritance.
function extractContextSummary(messages, maxChars = 800) {
  const recent = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0 && total < maxChars; i--) {
    const m = messages[i];
    // Include both assistant and user text (not tool_result blocks)
    if (m.role === "assistant" || m.role === "user") {
      let text = "";
      if (typeof m.content === "string") text = m.content;
      else if (Array.isArray(m.content)) {
        // For user messages, skip tool_result blocks (they're noise)
        const blocks = m.role === "user"
          ? m.content.filter((b) => b.type === "text")
          : m.content.filter((b) => b.type === "text");
        text = blocks.map((b) => b.text).join(" ");
      }
      if (text && text.trim()) {
        const prefix = m.role === "user" ? "U: " : "A: ";
        recent.unshift(prefix + text.slice(0, Math.floor(maxChars / 2)));
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
    debugLog(`upstream -> POST ${url} (model=${backend.model})`);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    debugLog(`upstream <- HTTP ${res.status} from ${backend.model}`);
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

  // Retry with exponential backoff on rate-limit (429/529/503) errors.
  // The classifier is on the hot path — a transient 529 shouldn't force
  // every request to default to medium. Up to 3 attempts: 0s, 1s, 2s.
  const MAX_CLASSIFIER_RETRIES = config.classifier?.maxRetries ?? 3;
  const RETRYABLE_STATUS = new Set([429, 503, 529, 520, 524]);

  for (let attempt = 0; attempt < MAX_CLASSIFIER_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_CLASSIFIER_RETRIES - 1) {
          const delay = attempt * 1000; // 0, 1s, 2s
          debugLog(`classifier HTTP ${res.status}, retry ${attempt + 1}/${MAX_CLASSIFIER_RETRIES} in ${delay}ms`);
          clearTimeout(timer);
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error(`classifier HTTP ${res.status}`);
      }
      const data = await res.json();
      return (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    } catch (e) {
      // AbortError or network error — retry if attempts remain
      if (attempt < MAX_CLASSIFIER_RETRIES - 1 && (e.name === "AbortError" || e.message.includes("ECONN"))) {
        const delay = (attempt + 1) * 1000;
        debugLog(`classifier error: ${e.message}, retry ${attempt + 1}/${MAX_CLASSIFIER_RETRIES} in ${delay}ms`);
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  // Should not reach here, but defensive
  throw new Error("classifier: all retries exhausted");
}

// ---------------------------------------------------------------
// Triage: classify complexity + clarity
// ---------------------------------------------------------------

// Heuristic pre-filter: skip the classifier entirely for prompts
// that are obviously one complexity level. Returns null if the
// prompt is ambiguous enough to warrant full classification.
// This saves a classifier call (+ latency + tokens) on the
// most common patterns in coding sessions.
// Set "heuristic": false in config to always go through the classifier.
const HEURISTIC_ENABLED = config.heuristic !== false;
function heuristicClassify(userText, contextSummary) {
  const lower = userText.toLowerCase().trim();

  // Greetings / acknowledgments → super_easy
  if (/^(hi|hey|hello|thanks|thank you|ok|okay|done|bye|good|yes|no|sure|cool|got it|right|correct|agreed|np|yw)\b/.test(lower) && !contextSummary) {
    return { complexity: "super_easy", clarity: "clear", assumptions: [], source: "heuristic" };
  }

  // Pure greetings even with context → easy (not super_easy, context exists)
  if (/^(hi|hey|hello|thanks|bye)\s*[!.]?\s*$/.test(lower) && contextSummary) {
    return { complexity: "easy", clarity: "clear", assumptions: [], source: "heuristic" };
  }

  // Obvious hard/super_hard keywords → skip classifier
  const hardKeywords = /\b(refactor|redesign|architect|distribute|scale|optimize|migrate|debug\s+crash|multi-?file|rewrite|overhaul)\b/i;
  const superHardKeywords = /\b(design\s+(system|architecture|distributed|infra)|prove|autonomous|from\s+scratch|ground\s+up)\b/i;

  if (superHardKeywords.test(userText)) {
    return { complexity: "super_hard", clarity: "clear", assumptions: [], source: "heuristic" };
  }
  if (hardKeywords.test(userText)) {
    return { complexity: "hard", clarity: "clear", assumptions: [], source: "heuristic" };
  }

  // Very short (< 10 words) with context → inherit, don't re-classify
  if (wordCount(userText) < 10 && contextSummary) {
    return null; // let the session inheritance logic handle it
  }

  // No heuristic match → fall through to classifier
  return null;
}

async function triage(userText, systemPrompt, contextSummary) {
  const sysSnippet = typeof systemPrompt === "string"
    ? systemPrompt.slice(0, 800)
    : JSON.stringify(systemPrompt || "").slice(0, 800);

  const { format } = buildTriagePrompt(userText, sysSnippet, contextSummary);

  // --- Keyword-format triage (from ROUTES.md / alexrudloff pattern) ---
  // Enhanced: also extract clarity from keyword responses. The keyword
  // prompt now asks for "complexity|clarity" format. If the response
  // only contains a complexity word, clarity defaults to "clear".
  if (format === "keyword") {
    // Check classification cache first
    const cacheKey = crypto.createHash("sha1").update(`kw:${userText}|ctx:${contextSummary || ""}`).digest("hex");
    const cached = getCachedClassification(cacheKey);
    if (cached) {
      debugLog(`classifier cache hit for keyword triage (key=${cacheKey.slice(0,8)})`);
      return cached;
    }

    const { prompt } = buildTriagePrompt(userText, sysSnippet, contextSummary);
    try {
      const resultText = await callClassifier({
        model: config.classifier.model,
        max_tokens: 50,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      });
      debugLog(`classifier (${config.classifier.model}) replied: ${JSON.stringify(resultText.slice(0, 200))}`);
      const complexity = extractComplexityKeyword(resultText);

      // Extract clarity from keyword response (format: "medium|ambiguous")
      const cleaned = resultText.toLowerCase().replace(/<think>.*?<\/think>/gs, "").trim();
      const clarityMatch = cleaned.match(/\|\s*(ambiguous|clear)\s*$/);
      const clarity = clarityMatch ? clarityMatch[1] : "clear";
      // Extract assumptions if clarity is ambiguous and response has them
      let assumptions = [];
      if (clarity === "ambiguous") {
        const assumeMatch = cleaned.match(/assumptions?:\s*(.+)/i);
        if (assumeMatch) {
          assumptions = assumeMatch[1].split(/[;,]/).map(a => a.trim()).filter(a => a).slice(0, 4);
        }
        if (!assumptions.length) assumptions = ["proceeding with best guess"];
      }

      const result = { complexity, clarity, assumptions };
      setCachedClassification(cacheKey, result);
      return result;
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

  // Check classification cache
  const jsonCacheKey = crypto.createHash("sha1").update(`json:${userText}|ctx:${contextSummary || ""}|sys:${sysSnippet || ""}`).digest("hex");
  const jsonCached = getCachedClassification(jsonCacheKey);
  if (jsonCached) {
    debugLog(`classifier cache hit for JSON triage (key=${jsonCacheKey.slice(0,8)})`);
    return jsonCached;
  }

  try {
    const raw = await callClassifier(triageBody);
    debugLog(`classifier (${config.classifier.model}) replied: ${JSON.stringify(raw.slice(0, 300))}`);
    const cleaned = raw.replace(/^```json\s*|^```\s*|```$/gm, "").trim();
    const parsed = JSON.parse(cleaned);
    const complexity = COMPLEXITY_LEVELS.includes(parsed.complexity)
      ? parsed.complexity
      : "medium";
    const result = {
      complexity,
      clarity: parsed.clarity === "ambiguous" ? "ambiguous" : "clear",
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.slice(0, 4) : [],
    };
    setCachedClassification(jsonCacheKey, result);
    return result;
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

// Append text to a message, handling both content shapes (string or
// block array). Always appends AFTER existing blocks: tool_result
// blocks must come first in a user message, and a cache_control marker
// on an earlier block is unaffected by blocks appended after it. Never
// add our own cache_control — the client may already use all 4
// breakpoints, and a 5th is a request-rejecting error.
function appendTextToMessage(msg, text) {
  if (typeof msg.content === "string") {
    msg.content = msg.content + text;
  } else if (Array.isArray(msg.content)) {
    msg.content = [...msg.content, { type: "text", text: text.trim() }];
  }
}

function appendClarificationNote(messages, userIndex, assumptions) {
  debugLog(`clarify: appending ${assumptions.length} assumption(s) to user message #${userIndex}`);
  const note =
    "\n\n[router auto-clarification — your request looked underspecified, " +
    "proceeding with these assumptions unless you say otherwise:\n" +
    assumptions.map((a) => `- ${a}`).join("\n") +
    "]";

  appendTextToMessage(messages[userIndex], note);
}

// ---------------------------------------------------------------
// Repository map: build + inject
// ---------------------------------------------------------------
// Walks REPO_MAP_ROOT once at startup, extracts top-level exported
// names from source files via regex, formats as a compact text block.
// No deps, no tree-sitter, no AST — good enough for the 90% case
// (function/class/const signatures) across the common languages.
//
// Cache is TTL-based (REPO_MAP_TTL_MS); POST /map/refresh forces an
// immediate rebuild. Rebuilds only affect sessions frozen afterward.

const REPO_MAP_SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out",
  ".next", ".nuxt", ".vercel", ".cache", "coverage", ".turbo",
  "__pycache__", ".pytest_cache", ".venv", "venv", "env", ".env",
  ".idea", ".vscode", "target", "vendor", ".gradle", ".mypy_cache",
  ".tox", ".eggs", "Pods", "Carthage", "DerivedData",
]);
const REPO_MAP_CODE_EXT = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".sh", ".bash", ".zsh",
]);
const REPO_MAP_MAX_EXPORTS = 8;
const REPO_MAP_MAX_PATH_LEN = 96;
const REPO_MAP_MAX_DEPTH = 8;
const REPO_MAP_READ_BYTES = 64 * 1024; // exports are at the top; no need to scan whole files

let repoMapCache = null;
let repoMapBytes = 0;
let repoMapFileCount = 0;
let repoMapBuiltAt = 0; // epoch ms of last build; 0 = never

function buildRepoMap() {
  const root = path.resolve(REPO_MAP_ROOT);
  const lines = [];
  let budgetHit = false;
  repoMapBytes = 0;
  repoMapFileCount = 0;
  const maxBytes = REPO_MAP_MAX_TOKENS * 4; // ~4 chars/token

  function walk(dir, depth) {
    if (repoMapBytes >= maxBytes) { budgetHit = true; return; }
    if (depth > REPO_MAP_MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) { return; } // unreadable dir — skip silently
    // Dirs first, then files, alphabetical within each group.
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const ent of entries) {
      if (repoMapBytes >= maxBytes) { budgetHit = true; return; }
      // Skip dotfiles (but allow the root itself, which we entered via path.resolve)
      if (ent.name.startsWith(".") && ent.name !== ".") continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full);
      if (ent.isDirectory()) {
        if (REPO_MAP_SKIP_DIRS.has(ent.name)) continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!REPO_MAP_CODE_EXT.has(ext)) continue;
        if (rel.length > REPO_MAP_MAX_PATH_LEN) continue;
        const exports = extractExports(full, ext);
        // Indent paths by depth so the tree is skimmable.
        const indent = "  ".repeat(Math.min(depth, 4));
        const line = exports.length
          ? `${indent}${rel}  ->  ${exports.join(", ")}`
          : `${indent}${rel}`;
        lines.push(line);
        repoMapBytes += line.length + 1;
        repoMapFileCount++;
      }
    }
  }

  walk(root, 0);

  if (!lines.length) {
    repoMapCache = null;
    repoMapBytes = 0;
    repoMapFileCount = 0;
    return null;
  }

  // If the byte budget cut the walk short, SAY SO — otherwise the model
  // reads an alphabetically-truncated tree as the complete project.
  const header = `Project map (root: ${path.basename(root) || root}, ${repoMapFileCount} files` +
    (budgetHit ? " — TRUNCATED, more files not shown (maxTokens budget)" : "") + "):";
  repoMapCache = `${header}\n${lines.join("\n")}`;
  repoMapBytes = repoMapCache.length;
  repoMapBuiltAt = Date.now();
  writeRepoMapToFile();
  return repoMapCache;
}

// Write the cached map to a file, so the user can @include it in
// CLAUDE.md for every-turn visibility. Called after every rebuild.
// No-op if writeToFile is not configured.
function writeRepoMapToFile() {
  if (!REPO_MAP_WRITE_TO_FILE || !repoMapCache) return;
  try {
    const fullPath = path.resolve(REPO_MAP_ROOT, REPO_MAP_WRITE_TO_FILE);
    // Ensure parent directory exists (e.g. .router/repo-map.md).
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    // Prepend a header comment so the file is self-documenting when
    // the user opens it in their editor.
    const header =
      "<!-- Auto-generated by claude-smart-router. Do not edit. -->\n" +
      "<!-- Run POST /map/refresh or restart the router to regenerate. -->\n" +
      "<!-- To stop auto-generation, set repoMap.writeToFile=null in config.json. -->\n\n";
    fs.writeFileSync(fullPath, header + repoMapCache + "\n");
    debugLog(`repoMap: wrote to ${fullPath}`);
  } catch (e) {
    console.warn(`[router] repoMap: could not write to file ${REPO_MAP_WRITE_TO_FILE}: ${e.message}`);
  }
}

// Regex extraction of top-level exported names. Each language gets a
// small set of patterns — enough to surface the public surface area,
// not enough to be a real parser. Misses are fine; the map is a hint.
function extractExports(filePath, ext) {
  let src;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(REPO_MAP_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    src = buf.toString("utf8", 0, n);
  } catch (_) { return []; }

  const names = new Set();
  const collect = (re) => {
    let m;
    while ((m = re.exec(src)) !== null) {
      names.add(m[1]);
      if (names.size >= REPO_MAP_MAX_EXPORTS) break;
    }
  };

  if (ext === ".js" || ext === ".jsx" || ext === ".ts" || ext === ".tsx" || ext === ".mjs" || ext === ".cjs") {
    collect(/export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g);
    collect(/export\s+(?:default\s+)?class\s+(\w+)/g);
    collect(/export\s+const\s+(\w+)/g);
    collect(/^(?:async\s+)?function\s+(\w+)/gm);
    collect(/^class\s+(\w+)/gm);
  } else if (ext === ".py") {
    collect(/^(?:async\s+)?def\s+(\w+)/gm);
    collect(/^class\s+(\w+)/gm);
  } else if (ext === ".go") {
    collect(/^func\s+(?:\([^)]*\)\s+)?(\w+)/gm);
    collect(/^type\s+(\w+)\s+/gm);
  } else if (ext === ".rs") {
    collect(/^(?:pub\s+)?fn\s+(\w+)/gm);
    collect(/^(?:pub\s+)?struct\s+(\w+)/gm);
    collect(/^(?:pub\s+)?enum\s+(\w+)/gm);
  } else if (ext === ".java" || ext === ".kt") {
    collect(/(?:class|interface|enum|record)\s+(\w+)/g);
  } else if (ext === ".rb") {
    collect(/^def\s+(?:self\.)?(\w+)/gm);
    collect(/^(?:class|module)\s+(\w+)/gm);
  } else if (ext === ".php") {
    collect(/(?:^|\s)(?:function|class|interface)\s+(\w+)/g);
  }
  // .sh / .bash / .zsh: surface defined functions only.
  else if (ext === ".sh" || ext === ".bash" || ext === ".zsh") {
    collect(/^(\w+)\s*\(\s*\)\s*\{/gm);
  }

  return Array.from(names).slice(0, REPO_MAP_MAX_EXPORTS);
}

function getRepoMap() {
  // TTL: if the cache is older than REPO_MAP_TTL_MS (or never built),
  // rebuild before returning. This catches file additions / deletions
  // without the overhead of a file watcher. The walk is <100ms for a
  // typical project, so this is cheap relative to an LLM round-trip.
  if (repoMapCache === null || Date.now() - repoMapBuiltAt > REPO_MAP_TTL_MS) {
    return buildRepoMap();
  }
  return repoMapCache;
}

// Read pinned files at FREEZE time (not per-request). Pinned content
// becomes part of the session's frozen bytes — re-reading it every turn
// would let a mid-session edit change the injected prefix and break the
// cache on every turn the file changed.
// Returns an array of { path, content } objects; missing/unreadable files
// are silently skipped. Each file is capped at REPO_MAP_PINNED_MAX_BYTES.
function readPinnedFiles() {
  if (!REPO_MAP_PINNED_FILES.length) return [];
  const root = path.resolve(REPO_MAP_ROOT);
  const out = [];
  for (const rel of REPO_MAP_PINNED_FILES) {
    // Resolve relative to root; refuse absolute paths outside root to
    // avoid accidental exfiltration of system files via config.
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep) && full !== root) {
      console.warn(`[router] repoMap: skipping pinned file outside root: ${rel}`);
      continue;
    }
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      const fd = fs.openSync(full, "r");
      const size = Math.min(stat.size, REPO_MAP_PINNED_MAX_BYTES);
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      fs.closeSync(fd);
      const content = buf.toString("utf8");
      const truncated = stat.size > REPO_MAP_PINNED_MAX_BYTES;
      out.push({ path: rel, content, truncated, bytes: content.length });
    } catch (e) {
      // Missing pinned file is a config error worth flagging — the user
      // explicitly asked for this file, so silent skip would be confusing.
      console.warn(`[router] repoMap: could not read pinned file ${rel}: ${e.message}`);
    }
  }
  return out;
}

// Build the injection blocks. All pure functions of the map text /
// pinned files — rendered ONCE at freeze time and stored on the session
// entry, so every subsequent request appends byte-identical bytes
// (prompt-cache friendly; see the repoMap config block above).

function buildRepoMapBlock(mapText) {
  return (
    "\n\n[router project map — files in this project, for context. " +
    "Use Read/edit tools normally to inspect any of them; this is just " +
    "an overview so you know the shape of the codebase.]\n" +
    mapText +
    "\n[/router project map]"
  );
}

function buildPinnedBlock(pinnedFiles) {
  if (!pinnedFiles.length) return "";
  return (
    "\n\n[router pinned files — loaded verbatim for context]\n" +
    pinnedFiles.map((f) =>
      `\n=== ${f.path}${f.truncated ? ` (truncated at ${REPO_MAP_PINNED_MAX_BYTES} bytes)` : ""} ===\n${f.content}`
    ).join("\n") +
    "\n[/router pinned files]"
  );
}

// Pinned blocks rendered at different freeze times are separate string
// allocations even when the content is identical — 500 sessions × 80KB
// of pinned files would be ~40MB of duplicates. Interning keeps one
// copy per distinct content (single-slot cache: pinned files change
// rarely, and a miss only costs one extra render).
let sharedPinned = { hash: null, block: "" };
function internPinnedBlock(pinnedFiles) {
  if (!pinnedFiles.length) return "";
  const hash = crypto
    .createHash("sha1")
    .update(pinnedFiles.map((f) => f.path + "\x00" + f.content).join("\x01"))
    .digest("hex");
  if (sharedPinned.hash === hash) return sharedPinned.block;
  const block = buildPinnedBlock(pinnedFiles);
  sharedPinned = { hash, block };
  return block;
}

// One-liner variant of the map, injected once the session crosses its
// compactAfter threshold. Derived from the RAW map text (not the
// rendered block): the header is skipped by "Project map" prefix — NOT
// by indentation, which would silently drop root-level files (depth-0
// lines have no indent).
function buildCompactBlockText(mapText) {
  const filePaths = [];
  for (const line of mapText.split("\n")) {
    if (line.startsWith("Project map")) continue;
    // path-like token containing an extension, optionally followed by
    // "  ->  export, names"
    const m = line.match(/^\s*([^\[\n]+?\.[a-zA-Z0-9]+)\s*(?:->|$)/);
    if (m) filePaths.push(m[1].trim());
  }
  const shown = filePaths.slice(0, 15);
  const more = filePaths.length > 15 ? ` (+${filePaths.length - 15} more)` : "";
  return (
    `\n\n[router project map (compacted) — ${filePaths.length} files. ` +
    `Key: ${shown.join(", ")}${more}. ` +
    `Use Read to inspect any of them.]`
  );
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
  debugLog(`<- ${req.method} ${req.url}`);

  // Dispatch on the path only — Claude Code appends query strings
  // (e.g. /v1/messages?beta=true), and an exact-string match would
  // silently dump those into the un-routed passthrough branch.
  const pathname = (req.url || "").split("?")[0];

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
    const budgetBreached = [...sessionBudget.values()].filter((e) => e.breachedAt).length;
    const totalEscalations = [...sessionEscalations.values()].reduce((s, c) => s + c, 0);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        uptimeSeconds: Math.floor(process.uptime()),
        sessions: sessionBackend.size,
        classifyCacheSize: classifyCache.size,
        classifyCacheTtlMs: CLASSIFY_CACHE_TTL_MS,
        budgetMax: BUDGET_MAX,
        budgetBreachedSessions: budgetBreached,
        totalEscalations,
        creditsEnabled: CREDITS_ENABLED,
        credits5hPct: CREDITS_ENABLED ? creditsSnapshot().fiveHour.pct : null,
        creditsWeekPct: CREDITS_ENABLED ? creditsSnapshot().weekly.pct : null,
        peakNow: isPeakNow(),
        repoMapFiles: repoMapFileCount,
        repoMapBytes: repoMapBytes,
      })
    );
    return;
  }

  // Live GLM Coding Plan credit usage: 5-hour sliding window, weekly
  // cycle, peak-hour state. Numbers reflect only traffic that went
  // THROUGH the router (Z.AI MCP calls bypass it).
  if (req.method === "GET" && pathname === "/credits") {
    if (!CREDITS_ENABLED) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ enabled: false, note: "set credits.enabled=true in config.json" }, null, 2));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(creditsSnapshot(), null, 2));
    return;
  }

  // Inspect the current repo map (handy for debugging — confirm the
  // router is seeing the files you expect, check the byte budget).
  if (req.method === "GET" && pathname === "/map") {
    if (!REPO_MAP_ENABLED) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("(repo map disabled — set repoMap.enabled=true in config.json)\n");
      return;
    }
    const map = getRepoMap();
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end((map || "(no source files found under " + REPO_MAP_ROOT + ")\n") + "\n");
    return;
  }

  // Force a rebuild — call this after `git pull`, reorg, or any time the
  // cached map has gone stale. No body needed.
  if (req.method === "POST" && pathname === "/map/refresh") {
    if (!REPO_MAP_ENABLED) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ refreshed: false, reason: "repo map disabled" }));
      return;
    }
    repoMapCache = null;
    const map = buildRepoMap();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      refreshed: true,
      root: REPO_MAP_ROOT,
      files: repoMapFileCount,
      bytes: repoMapBytes,
      approxTokens: Math.ceil(repoMapBytes / 4),
    }));
    return;
  }

  if (req.method !== "POST" || pathname !== "/v1/messages") {
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
  const requestStart = Date.now(); // credit billing instant (peak vs off-peak)
  const { text, isToolResultOnly, index } = extractLastUserTurn(body.messages || []);
  const contextSummary = extractContextSummary(body.messages || []);

  // Detect if request includes tools (from alexrudloff/llmrouter)
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  debugLog(
    `request: session=${key.slice(0, 10)} messages=${(body.messages || []).length} ` +
    `tools=${hasTools ? body.tools.length : 0} stream=${!!body.stream}`
  );
  debugLog(`last user turn: ${JSON.stringify((text || "(empty)").slice(0, 200))}`);

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
    // Try heuristic pre-filter first (saves a classifier call for obvious cases)
    const heuristic = HEURISTIC_ENABLED ? heuristicClassify(text, contextSummary) : null;
    let t;
    if (heuristic) {
      t = heuristic;
      debugLog(`heuristic pre-filter: ${text.slice(0,60)} -> ${t.complexity} (${t.source})`);
    } else {
      t = await triage(text, body.system, contextSummary);
    }
    decision = { complexity: t.complexity, assumptions: t.clarity === "ambiguous" ? t.assumptions : [] };
    classifiedComplexity = t.complexity;
    console.log(
      `[router] complexity=${t.complexity} clarity=${t.clarity}` +
        (t.assumptions.length ? ` assumptions=${JSON.stringify(t.assumptions)}` : "") +
        (t.source ? ` source=${t.source}` : "")
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

  // Repo map freeze: on the first turn whose CLASSIFIED (pre-tool-floor)
  // complexity clears the floor, render and freeze the payload on the
  // session entry. Once frozen, TTL rebuilds and /map/refresh never touch
  // it — rewriting a live session's bytes would break its cache prefix.
  // Gating on the classified value (not the tool-floor-bumped one)
  // matters: Claude Code sends tools on every request, so the bumped
  // value is always >= medium and a post-floor gate would be decorative.
  // If the map build returns null (empty repo), don't freeze anything —
  // retry on a later qualifying turn; the TTL caps the walk frequency.
  const hadSession = sessionBackend.has(key);
  const priorSession = hadSession ? sessionBackend.get(key) : null;
  let repoMapPayload = priorSession?.repoMap || null;
  const repoMapFirstIdx = firstUserMessageIndex(body.messages);
  if (
    !repoMapPayload &&
    REPO_MAP_ENABLED &&
    repoMapFirstIdx >= 0 &&
    !isToolResultOnly &&
    COMPLEXITY_LEVELS.indexOf(classifiedComplexity) >= COMPLEXITY_LEVELS.indexOf(REPO_MAP_MIN_COMPLEXITY)
  ) {
    const mapText = getRepoMap();
    if (mapText) {
      const pinned = readPinnedFiles();
      repoMapPayload = {
        mapBlock: buildRepoMapBlock(mapText),
        compactBlock: buildCompactBlockText(mapText),
        pinnedBlock: internPinnedBlock(pinned),
        compactTier: classifiedComplexity,
      };
      const injectedChars = repoMapPayload.mapBlock.length + repoMapPayload.pinnedBlock.length;
      // Multiple user turns but no session entry = the entry was evicted
      // or the router restarted mid-conversation. Re-freezing may change
      // the injected bytes vs. what earlier turns carried (one cache
      // break) — say so, so the blip is diagnosable.
      const resumed = !hadSession && (body.messages || []).filter((m) => m.role === "user").length > 1;
      console.log(
        `[router] repoMap: froze session map (${injectedChars} chars` +
        (resumed ? "; session entry was lost — re-froze" : "") +
        ") on first qualifying turn"
      );
    }
  }

  setSession(key, {
    complexity: classifiedComplexity,
    assumptions: decision.assumptions,
    repoMap: repoMapPayload,
  });

  if (CLARIFY_ENABLED && decision.assumptions && decision.assumptions.length && index >= 0) {
    appendClarificationNote(body.messages, index, decision.assumptions);
  }

  // Re-inject the frozen payload into the session's FIRST user message
  // on every request. The Messages API is stateless — the client resends
  // its clean copy each turn — so one-shot injection would be seen by
  // exactly one model call. Same frozen bytes + same target message =
  // the mutated prefix is byte-identical across turns (cache-friendly).
  // Past the compact threshold (counted in REAL user turns, not tool
  // round-trips), the one-liner variant is injected instead: the switch
  // rewrites the prefix exactly once, then the compact bytes are just
  // as stable. Pinned files are never compacted.
  if (repoMapPayload && repoMapFirstIdx >= 0) {
    const threshold = REPO_MAP_COMPACT_AFTER[repoMapPayload.compactTier];
    const useCompact = threshold && countUserTextTurns(body.messages) > threshold;
    const block = (useCompact ? repoMapPayload.compactBlock : repoMapPayload.mapBlock) +
      repoMapPayload.pinnedBlock;
    appendTextToMessage(body.messages[repoMapFirstIdx], block);
    debugLog(
      `repoMap: re-injected ${useCompact ? "compact" : "full"} block ` +
      `(${block.length} chars) into first user message #${repoMapFirstIdx}`
    );
  }

  // Compaction hint: when the conversation is long and hasn't been hinted
  // yet for this session, inject a one-time nudge suggesting /compact.
  // This is cache-safe — it appends after the repo-map block on the first
  // user message, and fires at most once per session. The hint doesn't
  // change the message structure (no new messages, no reordering), just
  // adds text that the model may surface to the user.
  if (
    COMPACT_HINT_TURNS > 0 &&
    !sessionCompactedHint.has(key) &&
    countUserTextTurns(body.messages) >= COMPACT_HINT_TURNS &&
    repoMapFirstIdx >= 0
  ) {
    const hint =
      "\n\n[router: this conversation is getting long. Consider running /compact " +
      "to reduce context and improve response quality. You can also set " +
      "compactHintTurns in config.json to adjust this threshold.]";
    appendTextToMessage(body.messages[repoMapFirstIdx], hint);
    sessionCompactedHint.set(key, true);
    debugLog(`compaction hint injected at ${countUserTextTurns(body.messages)} turns`);
  }

  // Credit hints (one per session): 5h/weekly threshold crossing or a
  // peak-hours notice. Injected BEFORE the upstream call so this turn's
  // mutated body already carries it; threshold state comes from the
  // previous turn's recorded usage.
  maybeInjectCreditHints(key, repoMapFirstIdx, body.messages);

  // Budget enforcement: if session has breached budget, downgrade to cheapest
  // tier (or reject). This prevents a single runaway session from burning
  // through tokens — costWeights now have teeth, not just logging.
  const budgetEntry = sessionBudget.get(key);
  if (BUDGET_MAX && budgetEntry?.breachedAt) {
    if (BUDGET_REJECT) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `session budget exceeded (${budgetEntry.cumulative.toFixed(2)} >= ${BUDGET_MAX})` }));
      return;
    }
    // Downgrade to cheapest tier instead of rejecting
    const cheapest = COMPLEXITY_LEVELS[0];
    if (COMPLEXITY_LEVELS.indexOf(decision.complexity) > 0) {
      console.warn(`[router] budget breached -> downgrading ${decision.complexity} to ${cheapest}`);
      decision.complexity = cheapest;
    }
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
  debugLog(`routing: ${JSON.stringify((text || "(no text)").slice(0, 80))} -> ${decision.complexity} -> ${backend.model} @ ${backend.baseUrl}`);

  // Track cost for this turn
  addSessionCost(key, costWeight);

  try {
    const upstream = await callBackend(backend, body, { stream: !!body.stream });

    // Failure-based auto-escalation: on non-streaming responses, check
    // for failure patterns and retry on a higher tier if allowed.
    // For streaming, we can't inspect the body before forwarding, so
    // escalation only triggers on HTTP errors or non-stream responses.
    if (!body.stream && upstream.status === 200) {
      const cloned = upstream.clone();
      try {
        const data = await cloned.json();
        recordCredits(backend.model, data.usage, requestStart);
        const textContent = (data.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const isFailure = FAILURE_PATTERNS.some((p) => p.test(textContent));

        if (isFailure) {
          const escCount = sessionEscalations.get(key) || 0;
          const currentIdx = COMPLEXITY_LEVELS.indexOf(decision.complexity);
          if (escCount < MAX_ESCALATIONS_PER_SESSION && currentIdx < COMPLEXITY_LEVELS.length - 1) {
            const escalated = COMPLEXITY_LEVELS[currentIdx + 1];
            console.warn(`[router] failure detected -> auto-escalating ${decision.complexity} -> ${escalated}`);
            sessionEscalations.set(key, escCount + 1);
            // Retry with higher tier
            const escBackend = resolveRoute(escalated);
            const escBody = JSON.parse(JSON.stringify(body));
            escBody.model = escBackend.model;
            try {
              const escUpstream = await callBackend(escBackend, escBody, { stream: false });
              const escHeaders = { "content-type": escUpstream.headers.get("content-type") || "application/json" };
              res.writeHead(escUpstream.status, escHeaders);
              const escText = await escUpstream.text();
              try { recordCredits(escBackend.model, JSON.parse(escText).usage, requestStart); } catch (_) {}
              res.end(escText);
              return;
            } catch (escE) {
              // Escalation failed too — fall through to send original response
              console.warn(`[router] escalation also failed: ${escE.message}`);
            }
          }
        }
      } catch (_) { /* JSON parse failed — send original response */ }
    }

    // Upstream HTTP error that might benefit from escalation (5xx from cheap model)
    if (upstream.status >= 500 && !body.stream) {
      const escCount = sessionEscalations.get(key) || 0;
      const currentIdx = COMPLEXITY_LEVELS.indexOf(decision.complexity);
      if (escCount < MAX_ESCALATIONS_PER_SESSION && currentIdx < COMPLEXITY_LEVELS.length - 1) {
        const escalated = COMPLEXITY_LEVELS[currentIdx + 1];
        console.warn(`[router] upstream HTTP ${upstream.status} -> auto-escalating ${decision.complexity} -> ${escalated}`);
        sessionEscalations.set(key, escCount + 1);
        const escBackend = resolveRoute(escalated);
        const escBody = JSON.parse(JSON.stringify(body));
        escBody.model = escBackend.model;
        try {
          const escUpstream = await callBackend(escBackend, escBody, { stream: false });
          const escHeaders = { "content-type": escUpstream.headers.get("content-type") || "application/json" };
          res.writeHead(escUpstream.status, escHeaders);
          const escText = await escUpstream.text();
          try { recordCredits(escBackend.model, JSON.parse(escText).usage, requestStart); } catch (_) {}
          res.end(escText);
          return;
        } catch (escE) {
          console.warn(`[router] escalation also failed: ${escE.message}`);
        }
      }
    }

    const headers = { "content-type": upstream.headers.get("content-type") || "application/json" };
    res.writeHead(upstream.status, headers);

    if (upstream.body) {
      const readable = Readable.fromWeb(upstream.body);
      readable.on("error", (e) => {
        console.error(`[router] upstream stream error: ${e.message}`);
        if (!res.writableEnded) res.end();
      });
      readable.pipe(res);
      // pipe() first, then observe: both listeners receive every chunk.
      if (CREDITS_ENABLED && body.stream && upstream.status === 200) {
        trackStreamedUsage(readable, backend.model, requestStart);
      }
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
  console.log(`[router] debug=${DEBUG ? "on (per-request trace)" : "off (set debug:true in config or DEBUG=1)"}`);
  console.log(`[router] classifyCacheTtl=${CLASSIFY_CACHE_TTL_MS}ms heuristicPreFilter=enabled`);
  if (BUDGET_MAX) console.log(`[router] budgetMax=${BUDGET_MAX} budgetReject=${BUDGET_REJECT}`);
  else console.log(`[router] budgetMax=none (set budgetMax in config.json to enforce)`);
  console.log(`[router] autoEscalation=enabled (max ${MAX_ESCALATIONS_PER_SESSION}/session, on failure patterns + 5xx)`);
  console.log(`[router] compactHint=${COMPACT_HINT_TURNS > 0 ? `at ${COMPACT_HINT_TURNS} turns` : "disabled"} (set compactHintTurns in config.json to adjust)`);
  if (CREDITS_ENABLED) {
    console.log(
      `[router] credits: tracking GLM plan — ${CREDIT_CAPS.fiveHour}/5h + ${CREDIT_CAPS.weekly}/wk, ` +
        `warn at ${CREDITS_WARN_PCT}%, hints=${CREDITS_HINTS ? "on" : "off"}, off-peak=0.5x ` +
        `(peak Mon-Fri 14:00-18:00 UTC+8)`
    );
    if (Number.isFinite(CREDITS_ANCHOR_MS)) {
      console.log(`[router] credits: weekly cycle resets ${new Date(weeklyResetAt()).toLocaleString()} local (anchor ${CREDITS_CFG.weeklyResetAnchor})`);
    } else {
      console.log(`[router] credits: no weeklyResetAnchor set — weekly window is a rolling 7 days (approximate)`);
    }
  } else {
    console.log(`[router] credits=disabled (set credits.enabled=true in config.json)`);
  }
  if (CREDITS_CFG.weeklyResetAnchor && !Number.isFinite(CREDITS_ANCHOR_MS)) {
    console.warn(`[router] credits: weeklyResetAnchor is not a valid date: ${JSON.stringify(CREDITS_CFG.weeklyResetAnchor)}`);
  }
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

  // Repo map: build eagerly so the first request doesn't pay the walk
  // cost, and so a misconfigured root surfaces at startup instead of
  // silently producing an empty map on turn 1.
  if (REPO_MAP_ENABLED) {
    const map = buildRepoMap();
    if (map) {
      console.log(
        `[router] repoMap=enabled root=${REPO_MAP_ROOT} files=${repoMapFileCount} ` +
        `bytes=${repoMapBytes} (~${Math.ceil(repoMapBytes / 4)} tokens, every request, frozen per session, min=${REPO_MAP_MIN_COMPLEXITY})`
      );
      console.log(`[router] repoMap: GET /map to inspect, POST /map/refresh to rebuild (new sessions only)`);
    } else {
      console.log(`[router] repoMap=enabled but no source files found under ${REPO_MAP_ROOT} (map will be skipped)`);
    }
    // Early validation of pinned files: warn now if any are missing or
    // unreadable, so the user discovers config typos at startup instead
    // of after sending their first message and seeing nothing injected.
    if (REPO_MAP_PINNED_FILES.length) {
      const pinned = readPinnedFiles();
      const found = new Set(pinned.map((p) => p.path));
      const missing = REPO_MAP_PINNED_FILES.filter((p) => !found.has(p));
      if (missing.length) {
        console.warn(`[router] repoMap: pinned file(s) not found/readable: ${missing.join(", ")}`);
      }
      const pinnedBytes = pinned.reduce((n, f) => n + f.bytes, 0);
      console.log(
        `[router] repoMap: pinnedFiles=${pinned.length}/${REPO_MAP_PINNED_FILES.length}` +
        (pinned.length ? ` (~${Math.ceil(pinnedBytes / 4)} tokens, max ${REPO_MAP_PINNED_MAX_BYTES}B each)` : "")
      );
    }
    if (REPO_MAP_WRITE_TO_FILE) {
      console.log(`[router] repoMap: writeToFile=${REPO_MAP_WRITE_TO_FILE} (use @include in CLAUDE.md for every-turn visibility)`);
    }
    const thresholds = Object.entries(REPO_MAP_COMPACT_AFTER)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`[router] repoMap: compactAfter=${thresholds} (real user turns; tool round-trips don't count)`);
  } else {
    console.log(`[router] repoMap=disabled (set repoMap.enabled=true in config.json to enable)`);
  }
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
  saveCreditState(); // flush the weekly ledger so restarts don't lose usage
  server.close(() => {
    console.log("[router] closed.");
    process.exit(0);
  });
  // fetch()-based clients hold idle keep-alive sockets open, which keeps
  // server.close()'s callback pending until they idle out — drop the
  // idle ones so shutdown completes promptly (in-flight streams still
  // get the 10s grace below).
  if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
  setTimeout(() => {
    console.error("[router] forced exit after 10s — some connections did not close.");
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
