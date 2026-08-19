#!/usr/bin/env node
/**
 * End-to-end test runner for claude-smart-router.
 *
 * Boots:
 *   - mock backends (test/mock-backends.js) on :9911/:9912
 *   - router.js on :9877 with generated test configs
 * and asserts on:
 *   - what model/backend the router actually forwarded to (from mock logs)
 *   - what the router replied to the client
 *
 * Usage: node test/run-tests.js [name-filter]
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOG_DIR = path.join(__dirname, "logs");
// Ports are env-overridable so the suite can run next to a live router
// (e.g. TEST_ROUTER_PORT=9879 npm test while the real one holds 9877).
const ROUTER_PORT = Number(process.env.TEST_ROUTER_PORT || 9877);
const AN_PORT = Number(process.env.TEST_AN_PORT || 9911);
const OL_PORT = Number(process.env.TEST_OL_PORT || 9912);
const AN_BASE = `http://localhost:${AN_PORT}`;
const OL_BASE = `http://localhost:${OL_PORT}`;

// ---------------------------------------------------------------
// tiny test framework
// ---------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];
const filter = process.argv[2] || null;

// test() must be hoisted: runTests references it before the declaration
// executes, so declare with `function`.
function test(name, fn) {
  if (filter && !name.includes(filter)) return Promise.resolve();
  console.log(`\n-- ${name}`);
  return Promise.resolve().then(fn).catch((e) => {
    failed++;
    failures.push({ label: name, detail: e.stack || e.message });
    console.log(`  FAIL  threw: ${e.message}`);
  });
}

function ok(cond, label, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push({ label, detail });
    console.log(`  FAIL  ${label}${detail ? `\n        ${String(detail).split("\n").join("\n        ")}` : ""}`);
  }
}

function eq(actual, expected, label) {
  ok(
    actual === expected,
    label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

// ---------------------------------------------------------------
// process management
// ---------------------------------------------------------------

let routerProc = null;
let mockProc = null;

function waitReady(proc, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      reject(new Error(`${name} did not signal ready in ${timeoutMs}ms; output:\n${out}`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("listening") || out.includes("backend on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stdout.on("error", () => {});
  });
}

function startMock(env = {}) {
  mockProc = spawn(process.execPath, [path.join(__dirname, "mock-backends.js")], {
    env: { ...process.env, LOG_DIR: LOG_DIR, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  mockProc.stdout.on("data", () => {});
  mockProc.stderr.on("data", (d) => process.stderr.write(`[mock] ${d}`));
  return waitReady(mockProc, "mock", 10_000);
}

async function startRouter(configFile, env = {}) {
  // Never leak the previous instance: overwriting routerProc without
  // stopping it leaves a process holding the port, and this spawn dies
  // on EADDRINUSE. stopRouter is hoisted, so this is safe to call here.
  await stopRouter();
  routerProc = spawn(process.execPath, [path.join(ROOT, "router.js")], {
    env: {
      ...process.env,
      ROUTER_CONFIG: configFile,
      ROUTES_PATH: env.ROUTES_PATH !== undefined ? env.ROUTES_PATH : path.join(ROOT, "ROUTES.md"),
      // Isolate from any ambient .env (repo root or cwd) — tests that
      // exercise .env behavior set ROUTER_ENV_PATH explicitly.
      ROUTER_ENV_PATH: env.ROUTER_ENV_PATH !== undefined ? env.ROUTER_ENV_PATH : path.join(LOG_DIR, "no-env-file"),
      // Isolate from the user's real keystore (~/.claude-smart-router):
      // a stored route/classifier key would override every mock key in
      // config and break the key-precedence tests on this machine.
      USERPROFILE: LOG_DIR,
      HOME: LOG_DIR,
      PORT: String(ROUTER_PORT),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  routerProc.stdout.on("data", () => {});
  routerProc.stderr.on("data", (d) => process.stderr.write(`[router] ${d}`));
  return waitReady(routerProc, "router", 10_000);
}

async function stopRouter() {
  if (!routerProc) return;
  const p = routerProc;
  routerProc = null;
  p.kill("SIGTERM");
  await new Promise((r) => {
    p.on("exit", r);
    setTimeout(r, 2000);
  });
}

async function stopMock() {
  if (!mockProc) return;
  const p = mockProc;
  mockProc = null;
  p.kill("SIGTERM");
  await stopProc(p);
}

// ---------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------

async function post(pathname, body, headers = {}, port = ROUTER_PORT) {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

// ---------------------------------------------------------------
// mock log helpers + control files
// ---------------------------------------------------------------

function readLog() {
  const f = path.join(LOG_DIR, "requests.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function clearLog() {
  fs.rmSync(path.join(LOG_DIR, "requests.jsonl"), { force: true });
}

// Control the mock backend's behavior (files it re-reads per request)
function setReply(v) {
  fs.writeFileSync(path.join(LOG_DIR, "CLASSIFIER_REPLY"), v);
}
function setTierStatus(v) {
  fs.writeFileSync(path.join(LOG_DIR, "TIER_STATUS"), String(v));
}

function chatCalls() {
  return readLog().filter(
    (e) => e.server === "anthropic" && e.url === "/v1/messages" && e.model && !e.model.startsWith("classifier-")
  );
}

function classifierCalls() {
  return readLog().filter(
    (e) => e.server === "anthropic" && e.model && e.model.startsWith("classifier-")
  );
}

// ---------------------------------------------------------------
// config builders
// ---------------------------------------------------------------

const TIER_MODELS = {
  super_easy: "tier-flash",
  easy: "tier-easy",
  medium: "tier-medium",
  hard: "tier-hard",
  super_hard: "tier-opus",
};

function buildConfig({ tools = {}, routes = TIER_MODELS, classifierModel = "classifier-flash", repoMap = { enabled: false }, heuristic = false, classifyCacheTtlMs = 0 } = {}) {
  const cfg = {
    port: ROUTER_PORT,
    tools,
    classifier: { baseUrl: AN_BASE, apiKey: "test-key", model: classifierModel },
    routes: Object.fromEntries(
      Object.entries(routes).map(([k, model]) => [
        k,
        { baseUrl: AN_BASE, apiKey: `key-${k}`, model },
      ])
    ),
  };
  // Most suites test routing THROUGH the classifier, so the two
  // classification shortcuts stay off by default — dedicated tests
  // below opt in and cover them directly.
  cfg.heuristic = heuristic;
  cfg.classifyCacheTtlMs = classifyCacheTtlMs;
  // repoMap defaults OFF for the general suites so they stay hermetic —
  // the repo-map suite below opts in with its own configs + fixture root.
  if (repoMap) cfg.repoMap = repoMap;
  return cfg;
}

const CFG_JSON = path.join(LOG_DIR, "config.json");
const CFG_OLLAMA = path.join(LOG_DIR, "config-ollama.json");
const NO_ROUTES = path.join(LOG_DIR, "no-routes.md");

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(CFG_JSON, JSON.stringify(buildConfig(), null, 2));
{
  const c = buildConfig();
  c.classifier = {
    baseUrl: OL_BASE,
    apiKey: "ollama",
    model: "classifier-ollama",
    provider: "ollama",
  };
  fs.writeFileSync(CFG_OLLAMA, JSON.stringify(c, null, 2));
}

// Build a message body like Claude Code would send
function msgBody({ messages, system = "You are Claude Code.", tools = null, stream = false, model = "claude-sonnet-4-5" } = {}) {
  const b = { model, max_tokens: 1024, messages, stream };
  if (system !== null) b.system = system;
  if (tools) b.tools = tools;
  return b;
}

const TOOLS = [{ name: "Bash", description: "Run a bash command", input_schema: { type: "object" } }];

// ---------------------------------------------------------------
// tests
// ---------------------------------------------------------------

async function runTests() {
  console.log("== booting mock backends ==");
  fs.rmSync(path.join(LOG_DIR, "requests.jsonl"), { force: true });
  // Also clear behavior controls: a crashed/filtered previous run can
  // leave CLASSIFIER_REPLY behind, and the mock would serve the stale
  // reply to this run's first suites.
  fs.rmSync(path.join(LOG_DIR, "CLASSIFIER_REPLY"), { force: true });
  setTierStatus(200);
  await startMock();

  // ---------------- JSON mode (no ROUTES.md) ----------------
  console.log("\n== suite: JSON mode (built-in classifier) ==");
  await startRouter(CFG_JSON, { ROUTES_PATH: NO_ROUTES });

  await test("json: medium code request routes to medium tier", async () => {
    clearLog();
    setReply(JSON.stringify({ complexity: "medium", clarity: "clear", assumptions: [] }));
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a quick sort function for me in JavaScript please" }],
    }));
    eq(r.status, 200, "status 200");
    ok(r.text.includes("reply-from-tier-medium"), "routed to tier-medium", r.text);
    const calls = chatCalls();
    eq(calls.length, 1, "exactly one chat call forwarded");
    eq(calls[0].model, "tier-medium", "upstream model rewritten to tier-medium");
    eq(calls[0].authHeader, "key-medium", "per-tier API key used");
  });

  await test("json: super_hard classifier result routes to super_hard tier", async () => {
    clearLog();
    setReply(JSON.stringify({ complexity: "super_hard", clarity: "clear", assumptions: [] }));
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Design a distributed consensus algorithm with formal proofs and autonomous agents" }],
    }));
    ok(r.text.includes("reply-from-tier-opus"), "routed to tier-opus", r.text);
    eq(chatCalls()[0].model, "tier-opus", "model is tier-opus");
  });

  await test("json: invalid classifier JSON falls back to medium", async () => {
    clearLog();
    setReply("I am thinking out loud, not JSON at all");
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Please refactor the authentication module across several files carefully" }],
    }));
    ok(r.text.includes("reply-from-tier-medium"), "fell back to tier-medium", r.text);
  });

  await test("json: markdown-fenced JSON is cleaned and parsed", async () => {
    clearLog();
    setReply("```json\n{\"complexity\":\"hard\",\"clarity\":\"clear\",\"assumptions\":[]}\n```");
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across the whole codebase now please" }],
    }));
    ok(r.text.includes("reply-from-tier-hard"), "parsed fenced JSON -> tier-hard", r.text);
  });

  await test("json: invalid complexity value falls back to medium", async () => {
    clearLog();
    setReply(JSON.stringify({ complexity: "extreme", clarity: "clear", assumptions: [] }));
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across the whole codebase now please" }],
    }));
    ok(r.text.includes("reply-from-tier-medium"), "bad complexity -> tier-medium", r.text);
  });

  await test("json: short follow-up inherits session complexity", async () => {
    clearLog();
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the entire authentication module across many files with full tests" }],
    }));
    eq(chatCalls()[0].model, "tier-hard", "turn 1 -> tier-hard");
    const r = await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: "Refactor the entire authentication module across many files with full tests" },
        { role: "assistant", content: "I have started the refactor of the auth module and identified ten files." },
        { role: "user", content: "yes" },
      ],
    }));
    ok(r.text.includes("reply-from-tier-hard"), "short follow-up inherited hard", r.text);
    eq(chatCalls()[1].model, "tier-hard", "turn 2 also tier-hard");
    eq(classifierCalls().length, 1, "turn 2 skipped the classifier (inheritance)");
  });

  await test("json: heuristic pre-filter classifies without the classifier", async () => {
    const p = path.join(LOG_DIR, "config-heuristic.json");
    fs.writeFileSync(p, JSON.stringify(buildConfig({ heuristic: true }), null, 2));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    // Garbage reply would fall back to medium if the classifier ran at
    // all — the heuristic must answer "refactor" -> hard on its own.
    setReply("definitely not json");
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across many files with tests" }],
    }));
    ok(r.text.includes("reply-from-tier-hard"), "heuristic routed refactor -> hard", r.text);
    eq(classifierCalls().length, 0, "classifier skipped entirely");
    await stopRouter();
    await startRouter(CFG_JSON, { ROUTES_PATH: NO_ROUTES });
  });

  await test("json: classify cache reuses the first classification of a prompt", async () => {
    const p = path.join(LOG_DIR, "config-cache.json");
    fs.writeFileSync(p, JSON.stringify(buildConfig({ classifyCacheTtlMs: 60_000 }), null, 2));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    const MSG_CACHE = [{ role: "user", content: "Analyze this interesting dataset and produce a report of the findings" }];
    setReply(JSON.stringify({ complexity: "easy", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({ messages: MSG_CACHE }));
    // Same prompt again — reply now says super_hard, but the cached
    // easy classification (within TTL) must win without a classifier call.
    setReply(JSON.stringify({ complexity: "super_hard", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({ messages: MSG_CACHE }));
    eq(classifierCalls().length, 1, "second identical prompt was a cache hit");
    eq(chatCalls()[1].model, "tier-easy", "cached easy routing reused");
    await stopRouter();
    await startRouter(CFG_JSON, { ROUTES_PATH: NO_ROUTES });
  });

  await test("json: short message w/o context defaults to super_easy", async () => {
    clearLog();
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "hi" }],
    }));
    eq(chatCalls()[0].model, "tier-flash", "hi -> tier-flash (super_easy)");
  });

  await test("json: tool-result-only continuation sticks to session tier", async () => {
    clearLog();
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Debug the crashing payment service and fix the root cause completely" }],
      tools: TOOLS,
    }));
    eq(chatCalls()[0].model, "tier-hard", "turn 1 tier-hard");
    await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: "Debug the crashing payment service and fix the root cause completely" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "exit 0, all tests pass" }] },
      ],
      tools: TOOLS,
    }));
    eq(chatCalls()[1].model, "tier-hard", "continuation sticks to tier-hard");
    eq(classifierCalls().length, 1, "continuation skipped classifier");
  });

  await test("json: tools floor bumps super_easy to medium", async () => {
    clearLog();
    setReply(JSON.stringify({ complexity: "super_easy", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "hey there friend how are you doing today hope everything is fine" }],
      tools: TOOLS,
    }));
    eq(chatCalls()[0].model, "tier-medium", "super_easy + tools -> tier-medium");
  });

  await test("json: floor bump does not poison session for later no-tools turn", async () => {
    clearLog();
    setReply(JSON.stringify({ complexity: "super_easy", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "hey there friend how are you doing today hope everything is fine" }],
      tools: TOOLS,
    }));
    eq(chatCalls()[0].model, "tier-medium", "turn 1 bumped to medium");
    // Turn 2: no tools, short follow-up with context — inherits the STORED
    // decision. If the floor bump mutated the stored object in place, the
    // stored complexity would read as medium instead of super_easy.
    await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: "hey there friend how are you doing today hope everything is fine" },
        { role: "assistant", content: "Hi! Everything is fine." },
        { role: "user", content: "ok" },
      ],
    }));
    eq(chatCalls()[1].model, "tier-flash", "session stores super_easy, not the bumped medium");
  });

  await test("json: ambiguous prompt gets clarification note appended", async () => {
    clearLog();
    setReply(JSON.stringify({
      complexity: "medium",
      clarity: "ambiguous",
      assumptions: ["Assume JavaScript", "Assume Node 18"],
    }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "write a script to process the file and output the results somewhere useful" }],
    }));
    const sent = chatCalls()[0].body.messages[0].content;
    ok(String(sent).includes("router auto-clarification"), "clarification note appended", sent);
    ok(String(sent).includes("- Assume JavaScript"), "assumption listed", sent);
  });

  await test("json: inherited turn does NOT re-append clarification note", async () => {
    clearLog();
    setReply(JSON.stringify({
      complexity: "medium",
      clarity: "ambiguous",
      assumptions: ["Assume JavaScript"],
    }));
    const AMB = "write a script to process the file and output the results somewhere useful";
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: AMB }],
    }));
    ok(
      String(chatCalls()[0].body.messages[0].content).includes("router auto-clarification"),
      "turn 1 has note"
    );
    await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: AMB },
        { role: "assistant", content: "I wrote the script. It reads the file and prints results." },
        { role: "user", content: "yes go ahead" },
      ],
    }));
    const turn2 = chatCalls()[1].body.messages;
    const lastUser = turn2[turn2.length - 1];
    ok(
      !String(lastUser.content).includes("router auto-clarification"),
      "turn 2 (inherited) has no note on the follow-up",
      lastUser.content
    );
    const noteCount = JSON.stringify(turn2).split("router auto-clarification").length - 1;
    eq(noteCount, 0, "zero notes anywhere in turn 2");
  });

  await test("json: tool-result-only turn after ambiguous turn has no note", async () => {
    clearLog();
    setReply(JSON.stringify({
      complexity: "medium",
      clarity: "ambiguous",
      assumptions: ["Assume JavaScript"],
    }));
    const AMB = "write a script to process the file and output the results somewhere useful";
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: AMB }],
      tools: TOOLS,
    }));
    await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: AMB },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
      ],
      tools: TOOLS,
    }));
    const turn2 = chatCalls()[1].body.messages;
    const noteCount = JSON.stringify(turn2).split("router auto-clarification").length - 1;
    eq(noteCount, 0, "no note on tool-result-only continuation");
  });

  await test("json: clarify=false disables note but keeps routing", async () => {
    const cfg = JSON.parse(fs.readFileSync(CFG_JSON, "utf8"));
    cfg.clarify = false;
    const p = path.join(LOG_DIR, "config-noclarify.json");
    fs.writeFileSync(p, JSON.stringify(cfg));
    await stopRouter();
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    setReply(JSON.stringify({
      complexity: "medium",
      clarity: "ambiguous",
      assumptions: ["Assume JavaScript"],
    }));
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "write a script to process the file and output the results somewhere useful" }],
    }));
    ok(r.text.includes("reply-from-tier-medium"), "still routed", r.text);
    ok(
      !JSON.stringify(chatCalls()[0].body.messages).includes("router auto-clarification"),
      "no clarification note"
    );
  });

  await test("json: streaming response is passed through", async () => {
    clearLog();
    setReply(JSON.stringify({ complexity: "easy", clarity: "clear", assumptions: [] }));
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "What is the capital of France and why is it called that name" }],
      stream: true,
    }));
    ok(r.text.includes("reply-from-tier-easy"), "stream reply body", r.text);
    ok(r.text.includes("message_start"), "SSE event present");
    const upstream = readLog().find((e) => e.url === "/v1/messages" && e.model === "tier-easy");
    ok(upstream && upstream.body.stream === true, "stream=true forwarded upstream");
  });

  await test("json: count_tokens endpoint passthrough (not routed as chat)", async () => {
    clearLog();
    const r = await post("/v1/messages/count_tokens", {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    eq(r.status, 200, "count_tokens 200");
    ok(r.text.includes("passthrough"), "hit passthrough branch", r.text);
    eq(chatCalls().length, 0, "no chat /v1/messages call for count_tokens");
    const entries = readLog().filter((e) => e.url === "/v1/messages/count_tokens");
    eq(entries.length, 1, "count_tokens forwarded to upstream once");
  });

  await test("json: OAuth token uses Bearer auth + beta headers", async () => {
    await stopRouter();
    const cfg = buildConfig();
    cfg.routes.hard.apiKey = "sk-ant-oat-test-oauth-token";
    const p = path.join(LOG_DIR, "config-oauth.json");
    fs.writeFileSync(p, JSON.stringify(cfg));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across many files with tests" }],
    }));
    const call = chatCalls()[0];
    eq(call.authHeader, "Bearer sk-ant-oat-test-oauth-token", "Bearer auth used for oat token");
    ok(
      String(call.anthropicBetaHeader || "").includes("oauth-2025-04-20"),
      "anthropic-beta oauth header set",
      call.anthropicBetaHeader
    );
  });

  await stopRouter();

  // ---------------- Keyword mode (ROUTES.md) ----------------
  console.log("\n== suite: keyword mode (ROUTES.md template) ==");
  await startRouter(CFG_JSON, { ROUTES_PATH: path.join(ROOT, "ROUTES.md") });

  await test("keyword: medium reply routes to medium tier", async () => {
    clearLog();
    setReply("keyword:medium");
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function for the data set in the project" }],
    }));
    ok(r.text.includes("reply-from-tier-medium"), "keyword medium -> tier-medium", r.text);
    eq(classifierCalls().length, 1, "classifier called once");
  });

  await test("keyword: classifier prompt contains ROUTES.md content + message", async () => {
    clearLog();
    setReply("keyword:easy");
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "What is the capital of France and why is it named that way" }],
    }));
    const cls = classifierCalls();
    const content = cls[0].body.messages[0].content;
    ok(String(content).includes("super_easy"), "template text present");
    ok(String(content).includes("What is the capital of France"), "user message substituted");
    ok(!String(content).includes("{MESSAGE}"), "placeholder replaced");
  });

  await test("keyword: follow-up builds Context/Message block", async () => {
    clearLog();
    setReply("keyword:medium");
    await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: "Write a sort function for the data set in the project" },
        { role: "assistant", content: "I wrote a merge sort implementation for you already." },
        { role: "user", content: "yes please continue with the implementation now thanks" },
      ],
    }));
    const content = classifierCalls()[0].body.messages[0].content;
    ok(String(content).includes("Context:"), "Context: block present");
    ok(String(content).includes("---"), "separator present");
    ok(String(content).includes("Message:"), "Message: label present");
    ok(String(content).includes("merge sort"), "assistant summary included in Context");
  });

  await test("keyword: <think> tags stripped from reply", async () => {
    clearLog();
    setReply("keyword:<think>hmm let me think</think>\nsuper_hard");
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Design a distributed system that survives partition and byzantine faults" }],
    }));
    ok(r.text.includes("reply-from-tier-opus"), "think-tags stripped -> super_hard", r.text);
  });

  await test("keyword: 'super_easy' word beats 'easy' partial match", async () => {
    clearLog();
    setReply("keyword:the answer is super_easy definitely");
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function for the data set in the project" }],
    }));
    eq(chatCalls()[0].model, "tier-flash", "super_easy not misread as easy");
  });

  await test("keyword: garbage reply falls back to medium", async () => {
    clearLog();
    setReply("keyword:potato");
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function for the data set in the project" }],
    }));
    ok(r.text.includes("reply-from-tier-medium"), "garbage -> medium", r.text);
  });

  await test("keyword: no clarification in keyword mode", async () => {
    clearLog();
    setReply("keyword:medium");
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "write a script to process the file and output results somewhere" }],
    }));
    ok(
      !JSON.stringify(chatCalls()[0].body.messages).includes("router auto-clarification"),
      "no note in keyword mode"
    );
  });

  await stopRouter();

  // ---------------- Ollama classifier ----------------
  console.log("\n== suite: Ollama classifier ==");
  await startRouter(CFG_OLLAMA, { ROUTES_PATH: NO_ROUTES });

  await test("ollama: classifier call goes to /api/generate", async () => {
    clearLog();
    setReply("medium");
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function for the data set in the project" }],
    }));
    const gen = readLog().filter((e) => e.server === "ollama" && e.url === "/api/generate");
    eq(gen.length, 1, "ollama /api/generate called");
    ok(r.text.includes("reply-from-tier-medium"), "medium reply routed", r.text);
    const payload = gen[0].body;
    eq(payload.options.temperature, 0, "temperature 0");
    eq(payload.stream, false, "stream false");
    ok(typeof payload.prompt === "string" && payload.prompt.length > 0, "prompt is non-empty string");
  });

  await test("ollama: JSON-mode prompt includes system instructions (flattened)", async () => {
    clearLog();
    // With a JSON reply that parses, routing must follow the reply — proving
    // the classifier output is used, not the parse-failure fallback. Before
    // the fix, payload.system (the JSON schema) was silently dropped.
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across many files with tests" }],
    }));
    const gen = readLog().filter((e) => e.server === "ollama" && e.url === "/api/generate");
    eq(gen.length, 1, "generate called");
    ok(
      String(gen[0].body.prompt).includes("fast triage step"),
      "system instructions flattened into prompt",
      gen[0].body.prompt
    );
    eq(chatCalls()[0].model, "tier-hard", "parsed JSON reply drove routing (not fallback)");
  });

  await stopRouter();

  // ---------------- Route fallback chain ----------------
  console.log("\n== suite: route resolution fallback ==");

  await test("fallback: missing tier falls back to nearest neighbor", async () => {
    const cfg = buildConfig();
    delete cfg.routes.medium;
    const p = path.join(LOG_DIR, "config-fallback.json");
    fs.writeFileSync(p, JSON.stringify(cfg));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    setReply(JSON.stringify({ complexity: "medium", clarity: "clear", assumptions: [] }));
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function for the data set in the project" }],
    }));
    ok(
      r.text.includes("reply-from-tier-easy") || r.text.includes("reply-from-tier-hard"),
      "fell back to a neighbor tier",
      r.text
    );
    await stopRouter();
  });

  await test("fallback: legacy light/heavy config routes", async () => {
    const cfg = buildConfig({ routes: { light: "legacy-light", heavy: "legacy-heavy" } });
    const p = path.join(LOG_DIR, "config-legacy.json");
    fs.writeFileSync(p, JSON.stringify(cfg));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across many files with tests" }],
    }));
    ok(r.text.includes("reply-from-legacy-heavy"), "hard maps to legacy-heavy", r.text);
    await stopRouter();
  });

  // ---------------- tools.model override ----------------
  console.log("\n== suite: tools.model override ==");

  await test("tools.model: forces fixed model when tools present", async () => {
    const cfg = buildConfig({ tools: { minComplexity: "medium", model: "forced-tool-model" } });
    const p = path.join(LOG_DIR, "config-toolsmodel.json");
    fs.writeFileSync(p, JSON.stringify(cfg));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    setReply(JSON.stringify({ complexity: "easy", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "What is the capital of France and why is it named that" }],
      tools: TOOLS,
    }));
    eq(chatCalls()[0].model, "forced-tool-model", "model forced to forced-tool-model");
    await stopRouter();
  });

  await test("tools.model: no tools -> normal routing", async () => {
    const cfg = buildConfig({ tools: { minComplexity: "medium", model: "forced-tool-model" } });
    const p = path.join(LOG_DIR, "config-toolsmodel2.json");
    fs.writeFileSync(p, JSON.stringify(cfg));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    setReply(JSON.stringify({ complexity: "easy", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "What is the capital of France and why is it named that" }],
    }));
    eq(chatCalls()[0].model, "tier-easy", "no tools -> tier routing");
    await stopRouter();
  });

  // ---------------- env var overrides ----------------
  console.log("\n== suite: env var overrides ==");

  await test("env: ROUTE_HARD_API_KEY overrides config key", async () => {
    await startRouter(CFG_JSON, { ROUTES_PATH: NO_ROUTES, ROUTE_HARD_API_KEY: "env-hard-key" });
    clearLog();
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across many files with tests" }],
    }));
    eq(chatCalls()[0].authHeader, "env-hard-key", "env key wins");
    await stopRouter();
  });

  await test("env: CLASSIFIER_API_KEY overrides classifier key", async () => {
    await startRouter(CFG_JSON, { ROUTES_PATH: NO_ROUTES, CLASSIFIER_API_KEY: "env-classifier-key" });
    clearLog();
    setReply(JSON.stringify({ complexity: "medium", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function for the data set in the project" }],
    }));
    const cls = classifierCalls();
    ok(cls.length >= 1, "classifier called");
    eq(cls[0].authHeader, "env-classifier-key", "classifier env key wins");
    await stopRouter();
  });

  await test("env: .env file supplies ROUTE_API_KEY for all tiers", async () => {
    const envFile = path.join(LOG_DIR, "test.env");
    fs.writeFileSync(envFile, "ROUTE_API_KEY=dotenv-glm-key\nCLASSIFIER_API_KEY=dotenv-classifier-key\n");
    await startRouter(CFG_JSON, { ROUTES_PATH: NO_ROUTES, ROUTER_ENV_PATH: envFile });
    clearLog();
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across many files with tests" }],
    }));
    eq(chatCalls()[0].authHeader, "dotenv-glm-key", ".env ROUTE_API_KEY applied to tier");
    const cls = classifierCalls();
    eq(cls[0].authHeader, "dotenv-classifier-key", ".env CLASSIFIER_API_KEY applied");
    await stopRouter();
  });

  await test("env: per-tier env var beats .env ROUTE_API_KEY", async () => {
    const envFile = path.join(LOG_DIR, "test2.env");
    fs.writeFileSync(envFile, "ROUTE_API_KEY=dotenv-glm-key\n");
    await startRouter(CFG_JSON, {
      ROUTES_PATH: NO_ROUTES,
      ROUTER_ENV_PATH: envFile,
      ROUTE_HARD_API_KEY: "real-env-hard-key",
    });
    clearLog();
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across many files with tests" }],
    }));
    eq(chatCalls()[0].authHeader, "real-env-hard-key", "real env var beats .env");
    await stopRouter();
  });

  await test("env: real environment beats .env value", async () => {
    const envFile = path.join(LOG_DIR, "test3.env");
    fs.writeFileSync(envFile, "ROUTE_HARD_API_KEY=from-dotenv\n");
    await startRouter(CFG_JSON, {
      ROUTES_PATH: NO_ROUTES,
      ROUTER_ENV_PATH: envFile,
      ROUTE_HARD_API_KEY: "from-real-env",
    });
    clearLog();
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across many files with tests" }],
    }));
    eq(chatCalls()[0].authHeader, "from-real-env", "process env wins over .env");
    await stopRouter();
  });

  // ---------------- router token auth ----------------
  console.log("\n== suite: proxy auth ==");

  await test("config: string routes + shared baseUrl/apiKey shorthand", async () => {
    const cfg = {
      baseUrl: AN_BASE,
      apiKey: "shared-key",
      heuristic: false,
      classifyCacheTtlMs: 0,
      classifier: { model: "classifier-flash" },
      routes: {
        super_easy: "tier-flash",
        easy: "tier-easy",
        medium: "tier-medium",
        hard: "tier-hard",
        super_hard: "tier-opus",
      },
    };
    const p = path.join(LOG_DIR, "config-shorthand.json");
    fs.writeFileSync(p, JSON.stringify(cfg));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across many files with tests" }],
    }));
    ok(r.text.includes("reply-from-tier-hard"), "string route resolved", r.text);
    eq(chatCalls()[0].model, "tier-hard", "string -> model");
    eq(chatCalls()[0].authHeader, "shared-key", "shared apiKey inherited");
    const cls = classifierCalls();
    eq(cls[0].authHeader, "shared-key", "classifier inherited shared key");
    ok(cls[0].url === "/v1/messages", "classifier inherited shared baseUrl");
    await stopRouter();
  });

  await test("config: per-route object overrides shared values", async () => {
    const cfg = {
      baseUrl: AN_BASE,
      apiKey: "shared-key",
      heuristic: false,
      classifyCacheTtlMs: 0,
      classifier: { model: "classifier-flash" },
      routes: {
        medium: "tier-medium",
        hard: { baseUrl: AN_BASE, apiKey: "own-hard-key", model: "tier-hard" },
        super_hard: "tier-opus",
      },
    };
    const p = path.join(LOG_DIR, "config-shorthand2.json");
    fs.writeFileSync(p, JSON.stringify(cfg));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Refactor the authentication module across many files with tests" }],
    }));
    eq(chatCalls()[0].authHeader, "own-hard-key", "per-route key beats shared");
    await stopRouter();
  });

  await test("auth: routerToken rejects bad auth, accepts good", async () => {
    const cfg = JSON.parse(fs.readFileSync(CFG_JSON, "utf8"));
    cfg.routerToken = "secret-token";
    const p = path.join(LOG_DIR, "config-token.json");
    fs.writeFileSync(p, JSON.stringify(cfg));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    const bad = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "hello there friend" }],
    }));
    eq(bad.status, 401, "no token -> 401");
    const wrong = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "hello there friend" }],
    }), { authorization: "Bearer nope" });
    eq(wrong.status, 401, "wrong token -> 401");
    const good = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "hello there friend" }],
    }), { authorization: "Bearer secret-token" });
    eq(good.status, 200, "correct token -> 200");
    await stopRouter();
  });

  // ---------------- error paths ----------------
  console.log("\n== suite: error handling ==");

  await test("errors: upstream 500 passes status through", async () => {
    await startRouter(CFG_JSON, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    setTierStatus(500);
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function for the data set in the project" }],
    }));
    eq(r.status, 500, "client sees 500");
    setTierStatus(200);
    await stopRouter();
  });

  await test("errors: unreachable upstream -> 502", async () => {
    const cfg = buildConfig();
    cfg.routes.medium.baseUrl = "http://localhost:9";
    const p = path.join(LOG_DIR, "config-unreachable.json");
    fs.writeFileSync(p, JSON.stringify(cfg));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES });
    clearLog();
    setReply(JSON.stringify({ complexity: "medium", clarity: "clear", assumptions: [] }));
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function for the data set in the project" }],
    }));
    eq(r.status, 502, "router returns 502");
    ok(r.text.includes("upstream call failed"), "error body from router", r.text);
    await stopRouter();
  });

  await test("errors: invalid JSON body -> 400", async () => {
    await startRouter(CFG_JSON, { ROUTES_PATH: NO_ROUTES });
    const r = await post("/v1/messages", "{not json");
    eq(r.status, 400, "400 for invalid JSON");
    await stopRouter();
  });

  // ---------------- repo map (frozen per session) ----------------
  console.log("\n== suite: repo map ==");

  const MAP_ROOT = path.join(__dirname, "fixtures", "map-root");
  const HARD_REPLY = () => setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
  async function startMapRouter(repoMap, env = {}) {
    const p = path.join(LOG_DIR, "config-map.json");
    fs.writeFileSync(p, JSON.stringify(buildConfig({ repoMap })));
    await startRouter(p, { ROUTES_PATH: NO_ROUTES, ROUTER_PROJECT_ROOT: MAP_ROOT, ...env });
  }
  const firstUserText = (call) =>
    typeof call.body.messages[0].content === "string"
      ? call.body.messages[0].content
      : call.body.messages[0].content.map((b) => b.text || "").join("");

  await test("repoMap: turn-1 injects frozen map into FIRST user message", async () => {
    await startMapRouter({ enabled: true });
    HARD_REPLY();
    clearLog();
    const r = await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: "map-firstmsg: analyze this whole project structure now" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "and keep going deeper please" },
      ],
    }));
    eq(r.status, 200, "200");
    const calls = chatCalls();
    eq(calls.length, 1, "one chat call");
    const first = JSON.stringify(calls[0].body.messages[0]);
    ok(first.includes("[router project map"), "map lands in first user message", first);
    ok(first.includes("one.js") && first.includes("alpha"), "map carries fixture file + export", first);
    ok(!JSON.stringify(calls[0].body.messages[2]).includes("[router project map"), "last user message untouched");
    ok(!first.includes("cache_control"), "router never adds its own cache_control", first);
    await stopRouter();
  });

  await test("repoMap: turn-2 re-injection is byte-identical (cache-stable)", async () => {
    await startMapRouter({ enabled: true });
    HARD_REPLY();
    clearLog();
    const t1 = "map-identical: refactor the routing logic across files here";
    await post("/v1/messages", msgBody({ messages: [{ role: "user", content: t1 }] }));
    await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: t1 },
        { role: "assistant", content: "done" },
        { role: "user", content: "now also update the tests accordingly please" },
      ],
    }));
    const calls = chatCalls();
    eq(calls.length, 2, "two chat calls");
    eq(
      JSON.stringify(calls[0].body.messages[0]),
      JSON.stringify(calls[1].body.messages[0]),
      "first user message byte-identical across turns"
    );
    await stopRouter();
  });

  await test("repoMap: compacts after N text turns; tool_result round-trips don't count", async () => {
    await startMapRouter({ enabled: true, compactAfter: { hard: 2 }, pinnedFiles: ["docs/pinned.md"] });
    HARD_REPLY();
    clearLog();
    const t1 = "map-compact: rewrite the parser and add error handling everywhere";
    // Turn 2: 2 text turns + 1 tool_result round-trip. If tool results
    // counted, this would already be >2 and compact — it must stay FULL.
    await post("/v1/messages", msgBody({ messages: [{ role: "user", content: t1 }] }));
    await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: t1 },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: "read the files" },
        { role: "user", content: "go ahead with the rewrite now thanks" },
      ],
    }));
    // Turn 3: 3 text turns > 2 -> compact variant.
    await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: t1 },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: "read the files" },
        { role: "user", content: "go ahead with the rewrite now thanks" },
        { role: "assistant", content: "rewriting" },
        { role: "user", content: "finally update the readme as well please" },
      ],
    }));
    const calls = chatCalls();
    eq(calls.length, 3, "three chat calls");
    const t2first = firstUserText(calls[1]);
    ok(t2first.includes("alpha") && !t2first.includes("(compacted)"), "turn 2 still FULL map (tool_result not counted)", t2first);
    const t3first = firstUserText(calls[2]);
    ok(t3first.includes("(compacted)"), "turn 3 uses compact variant", t3first);
    ok(t3first.includes("main.js") && t3first.includes("one.js"), "compact keeps paths incl. root-level main.js", t3first);
    ok(t3first.includes("ORIGINAL PINNED CONTENT"), "pinned files never compacted", t3first);
    await stopRouter();
  });

  await test("repoMap: enabled=false injects nothing", async () => {
    await startMapRouter({ enabled: false });
    HARD_REPLY();
    clearLog();
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "map-disabled: analyze this whole project deeply now" }],
    }));
    const calls = chatCalls();
    ok(!JSON.stringify(calls[0].body.messages).includes("[router project map"), "no map when disabled");
    await stopRouter();
  });

  await test("repoMap: freezes on first turn that clears minComplexity, not before", async () => {
    await startMapRouter({ enabled: true, minComplexity: "medium" });
    clearLog();
    // Turn 1: 2 words -> skips classifier -> super_easy, below the gate.
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    await post("/v1/messages", msgBody({ messages: [{ role: "user", content: "hi there" }] }));
    let calls = chatCalls();
    ok(!JSON.stringify(calls[0].body.messages[0]).includes("[router project map"), "trivial turn gets no map");
    // Turn 2: real task classifies hard -> freezes now.
    await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: "hi there" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "map-gated: build a new module for the export pipeline" },
      ],
    }));
    calls = chatCalls();
    const frozen = JSON.stringify(calls[1].body.messages[0]);
    ok(frozen.includes("[router project map"), "qualifying turn freezes map into first user message", frozen);
    // Turn 3: byte-stable re-injection of the same frozen payload.
    await post("/v1/messages", msgBody({
      messages: [
        { role: "user", content: "hi there" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "map-gated: build a new module for the export pipeline" },
        { role: "assistant", content: "built it" },
        { role: "user", content: "now wire it into the main entry point please" },
      ],
    }));
    calls = chatCalls();
    eq(frozen, JSON.stringify(calls[2].body.messages[0]), "post-freeze turns byte-identical");
    await stopRouter();
  });

  await test("repoMap: pinned content is read at freeze time only", async () => {
    const pinnedPath = path.join(MAP_ROOT, "docs", "pinned.md");
    const original = fs.readFileSync(pinnedPath, "utf8");
    try {
      await startMapRouter({ enabled: true, pinnedFiles: ["docs/pinned.md"] });
      HARD_REPLY();
      clearLog();
      const t1 = "map-pinned: audit the security of this codebase thoroughly";
      await post("/v1/messages", msgBody({ messages: [{ role: "user", content: t1 }] }));
      fs.writeFileSync(pinnedPath, "# Pinned doc\n\nCHANGED CONTENT\n");
      await post("/v1/messages", msgBody({
        messages: [
          { role: "user", content: t1 },
          { role: "assistant", content: "ok" },
          { role: "user", content: "continue the audit with the config files" },
        ],
      }));
      const calls = chatCalls();
      ok(firstUserText(calls[0]).includes("ORIGINAL PINNED CONTENT"), "freeze captures pinned content");
      ok(firstUserText(calls[1]).includes("ORIGINAL PINNED CONTENT"), "later turns re-use frozen bytes, not re-read file");
      ok(!firstUserText(calls[1]).includes("CHANGED CONTENT"), "on-disk change does not leak into session");
      await stopRouter();
    } finally {
      fs.writeFileSync(pinnedPath, original);
    }
  });

  // ---------------- misc ----------------
  await test("misc: GET / health check", async () => {
    await startRouter(CFG_JSON, { ROUTES_PATH: NO_ROUTES });
    const res = await fetch(`http://localhost:${ROUTER_PORT}/`);
    const text = await res.text();
    ok(text.includes("claude-smart-router is running"), "health text", text);
    await stopRouter();
  });

  // ---------------- summary ----------------
  console.log(`\n=========================================`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(` - ${f.label}`);
  }
  await stopMock();
  process.exit(failed ? 1 : 0);
}

runTests().catch(async (e) => {
  console.error("runner crashed:", e);
  await stopRouter();
  await stopMock();
  process.exit(1);
});
