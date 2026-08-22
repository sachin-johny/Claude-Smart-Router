#!/usr/bin/env node
/**
 * Security regression tests for claude-smart-router.
 *
 * These tests cover the specific vulnerabilities identified in the
 * engineering + security review:
 *
 *   S1 — ROUTER_TOKEN comparison must be constant-time
 *        (crypto.timingSafeEqual, not ===)
 *   S3 — Passthrough path must be allowlisted (no /../ escape, no
 *        arbitrary path forwarding that turns the proxy into a generic
 *        API-key-attaching forwarder)
 *   S5 — sessionKey must include metadata.user_id when present (so two
 *        unrelated Claude Code sessions on the same machine don't share
 *        routing/budget/escalation state just because their first user
 *        message happens to match)
 *
 * S7 (debug-log redaction) is covered by the round-3 additions to
 * run-tests.js, not here.
 *
 * Run: node test/security-tests.js
 *
 * Reuses the same mock-backend infrastructure as run-tests.js so it can
 * be added to `npm test` without new dependencies.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const LOG_DIR = path.join(__dirname, "logs");
const ROUTER_PORT = Number(process.env.TEST_ROUTER_PORT || 9881);
const AN_PORT = Number(process.env.TEST_AN_PORT || 9921);
const AN_BASE = `http://localhost:${AN_PORT}`;

// ---------------------------------------------------------------
// tiny test framework (same shape as run-tests.js)
// ---------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  console.log(`\n-- ${name}`);
  return Promise.resolve().then(fn).catch((e) => {
    failed++;
    failures.push({ label: name, detail: e.stack || e.message });
    console.log(`  FAIL  threw: ${e.message}`);
  });
}
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else {
    failed++;
    failures.push({ label, detail });
    console.log(`  FAIL  ${label}${detail ? `\n        ${String(detail).split("\n").join("\n        ")}` : ""}`);
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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
  });
}

async function startMock() {
  mockProc = spawn(process.execPath, [path.join(__dirname, "mock-backends.js")], {
    env: { ...process.env, LOG_DIR, PORT_AN: String(AN_PORT), PORT_OL: "9922" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  mockProc.stdout.on("data", () => {});
  mockProc.stderr.on("data", (d) => process.stderr.write(`[mock] ${d}`));
  return waitReady(mockProc, "mock", 10_000);
}

async function startRouter(configFile, env = {}) {
  if (routerProc) {
    routerProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
  }
  routerProc = spawn(process.execPath, [path.join(ROOT, "router.js")], {
    env: {
      ...process.env,
      ROUTER_CONFIG: configFile,
      ROUTES_PATH: env.ROUTES_PATH !== undefined ? env.ROUTES_PATH : path.join(LOG_DIR, "no-routes.md"),
      ROUTER_ENV_PATH: path.join(LOG_DIR, "no-env-file"),
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
  try { p.kill("SIGTERM"); } catch (_) {}
  await new Promise((r) => setTimeout(r, 300));
  try { p.kill("SIGKILL"); } catch (_) {}
  await new Promise((r) => setTimeout(r, 100));
}

async function stopAll() {
  await stopRouter();
  if (mockProc) {
    try { mockProc.kill("SIGTERM"); } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
    try { mockProc.kill("SIGKILL"); } catch (_) {}
    mockProc = null;
  }
}

// Raw HTTP request — fetch() normalizes /../ in URLs before sending,
// so to test path traversal we need to send the raw path over a socket.
function rawRequest(pathStr, method = "GET", port = ROUTER_PORT) {
  return new Promise((resolve, reject) => {
    const req = require("http").request({
      host: "localhost",
      port,
      method,
      path: pathStr,
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode, text: body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------
async function post(p, body, headers = {}) {
  const res = await fetch(`http://localhost:${ROUTER_PORT}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

function buildConfig(extra = {}) {
  return {
    port: ROUTER_PORT,
    classifier: { baseUrl: AN_BASE, apiKey: "test-key", model: "classifier-flash" },
    routes: {
      super_easy: { baseUrl: AN_BASE, apiKey: "key-super-easy", model: "tier-flash" },
      easy: { baseUrl: AN_BASE, apiKey: "key-easy", model: "tier-easy" },
      medium: { baseUrl: AN_BASE, apiKey: "key-medium", model: "tier-medium" },
      hard: { baseUrl: AN_BASE, apiKey: "key-hard", model: "tier-hard" },
      super_hard: { baseUrl: AN_BASE, apiKey: "key-super-hard", model: "tier-opus" },
    },
    heuristic: false,
    classifyCacheTtlMs: 0,
    ...extra,
  };
}

function msgBody({ messages, system = "You are Claude Code." } = {}) {
  return { model: "claude-sonnet-4-5", max_tokens: 1024, messages, system };
}

function setReply(v) {
  fs.writeFileSync(path.join(LOG_DIR, "CLASSIFIER_REPLY"), v);
}

function writeCfg(name, cfg) {
  const p = path.join(LOG_DIR, name);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

// ---------------------------------------------------------------
// tests
// ---------------------------------------------------------------
async function main() {
  console.log("== security regression tests ==");
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.rmSync(path.join(LOG_DIR, "requests.jsonl"), { force: true });
  fs.rmSync(path.join(LOG_DIR, "CLASSIFIER_REPLY"), { force: true });
  await startMock();

  // --------- S1: timing-safe ROUTER_TOKEN comparison ---------
  console.log("\n== suite: S1 — timing-safe auth ==");

  await test("S1: correct token still accepted (timingSafeEqual doesn't break happy path)", async () => {
    const cfg = buildConfig({ routerToken: "correct-secret-token-1234567890" });
    const p = writeCfg("sec-auth-correct.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    setReply(JSON.stringify({ complexity: "medium", clarity: "clear", assumptions: [] }));
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function" }],
    }), { authorization: "Bearer correct-secret-token-1234567890" });
    eq(r.status, 200, "correct token -> 200");
    await stopRouter();
  });

  await test("S1: wrong token of same length rejected (timingSafeEqual on equal-length)", async () => {
    const cfg = buildConfig({ routerToken: "correct-secret-token-1234567890" });
    const p = writeCfg("sec-auth-wrong-samelen.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function" }],
    }), { authorization: "Bearer corrext-secret-token-1234567890" }); // same 31 chars, different bytes
    eq(r.status, 401, "wrong token (same length) -> 401");
    await stopRouter();
  });

  await test("S1: wrong token of different length rejected", async () => {
    const cfg = buildConfig({ routerToken: "short-token" });
    const p = writeCfg("sec-auth-wrong-difflen.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function" }],
    }), { authorization: "Bearer this-is-a-much-longer-wrong-token-attempt" });
    eq(r.status, 401, "wrong token (different length) -> 401");
    await stopRouter();
  });

  await test("S1: empty Authorization header rejected", async () => {
    const cfg = buildConfig({ routerToken: "some-token" });
    const p = writeCfg("sec-auth-empty.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function" }],
    }), { authorization: "" });
    eq(r.status, 401, "empty auth -> 401");
    await stopRouter();
  });

  await test("S1: token without 'Bearer ' prefix still accepted (raw token fallback)", async () => {
    const cfg = buildConfig({ routerToken: "raw-token-value" });
    const p = writeCfg("sec-auth-raw.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    setReply(JSON.stringify({ complexity: "medium", clarity: "clear", assumptions: [] }));
    const r = await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "Write a sort function" }],
    }), { authorization: "raw-token-value" });
    eq(r.status, 200, "raw token (no Bearer prefix) -> 200");
    await stopRouter();
  });

  // --------- S3: passthrough path allowlist ---------
  console.log("\n== suite: S3 — passthrough path allowlist ==");

  await test("S3: /v1/messages/count_tokens is allowlisted (passes through)", async () => {
    const cfg = buildConfig();
    const p = writeCfg("sec-passthrough-ok.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    const r = await post("/v1/messages/count_tokens", { messages: [] });
    // mock returns 200 for /v1/messages/count_tokens (passthrough-shaped)
    ok(r.status === 200, `allowlisted path passes through (status=${r.status})`);
    await stopRouter();
  });

  await test("S3: /v1/models is allowlisted (GET, read-only)", async () => {
    const cfg = buildConfig();
    const p = writeCfg("sec-passthrough-models.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    const r = await fetch(`http://localhost:${ROUTER_PORT}/v1/models`);
    ok(r.status === 200, `allowlisted GET /v1/models passes through (status=${r.status})`);
    await stopRouter();
  });

  await test("S3: path traversal /../v1/account/billing rejected with 400", async () => {
    const cfg = buildConfig();
    const p = writeCfg("sec-passthrough-traversal.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    // fetch() normalizes /../ in URLs before sending, so we use a raw
    // HTTP request to send the literal path with /../ in it.
    const r = await rawRequest("/../v1/account/billing");
    ok(r.status === 400, `path traversal rejected with 400 (status=${r.status})`);
    ok(r.text.includes("traversal"), `error mentions traversal: ${r.text.slice(0, 100)}`);
    await stopRouter();
  });

  await test("S3: unknown path /v1/admin/users rejected with 404", async () => {
    const cfg = buildConfig();
    const p = writeCfg("sec-passthrough-unknown.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    const r = await fetch(`http://localhost:${ROUTER_PORT}/v1/admin/users`);
    ok(r.status === 404, `unknown path rejected with 404 (status=${r.status})`);
    const body = await r.text();
    ok(body.includes("not allowed"), `error mentions not allowed: ${body.slice(0, 100)}`);
    await stopRouter();
  });

  await test("S3: backslash path traversal rejected", async () => {
    const cfg = buildConfig();
    const p = writeCfg("sec-passthrough-backslash.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    // Send the raw backslash path — fetch would percent-encode it.
    const r = await rawRequest("/v1/messages\\..\\evil");
    ok(r.status === 400 || r.status === 404, `backslash traversal rejected (status=${r.status})`);
    await stopRouter();
  });

  // --------- S5: sessionKey includes metadata.user_id ---------
  console.log("\n== suite: S5 — session key disambiguation ==");

  await test("S5: same first message + different user_id -> different session keys (via routing state)", async () => {
    // We can't call sessionKey directly (it's not exported), but we CAN
    // observe its effect: if two sessions share a key, the second
    // request inherits routing state from the first. If keys differ,
    // the second request is classified independently.
    //
    // Setup: send a "hard" request as user A, then a "yes" follow-up as
    // user B with the SAME first message but a different user_id. The
    // router reads body.metadata.user_id (not any header), so the user
    // ids go in the body.
    const cfg = buildConfig();
    const p = writeCfg("sec-session-userid.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    fs.rmSync(path.join(LOG_DIR, "requests.jsonl"), { force: true });

    // Turn 1 as user A: classify as hard
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));
    const bodyA = msgBody({ messages: [{ role: "user", content: "Refactor the auth module" }] });
    bodyA.metadata = { user_id: "user-A" };
    await post("/v1/messages", bodyA);

    // Turn 2 as user B with SAME first message but different user_id,
    // sending only a short follow-up ("yes"). If the session key includes
    // user_id, this is a NEW session — "yes" is too short to classify,
    // defaults to super_easy. If the key does NOT include user_id, this
    // inherits from turn 1's "hard" classification.
    setReply(JSON.stringify({ complexity: "medium", clarity: "clear", assumptions: [] }));
    const bodyB = msgBody({
      messages: [
        { role: "user", content: "Refactor the auth module" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "yes" },
      ],
    });
    bodyB.metadata = { user_id: "user-B" };
    await post("/v1/messages", bodyB);

    const calls = fs.readFileSync(path.join(LOG_DIR, "requests.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.url === "/v1/messages" && e.model && !e.model.startsWith("classifier-"));
    // turn 1 should have routed to tier-hard (from "hard" classification)
    // turn 2: if session key includes user_id, it's a new session, "yes"
    // is too short to classify, defaults to super_easy (tier-flash).
    // If session key does NOT include user_id, turn 2 inherits "hard".
    eq(calls.length, 2, "two chat calls");
    const turn1Model = calls[0]?.model;
    const turn2Model = calls[1]?.model;
    ok(turn1Model === "tier-hard", `turn 1 routes to tier-hard (got ${turn1Model})`);
    ok(turn2Model === "tier-flash", `turn 2 routes to tier-flash (super_easy default, NOT inherited from user A) — got ${turn2Model}`);
    await stopRouter();
  });

  await test("S5: same user_id + same first message -> session inheritance still works", async () => {
    // Regression check: the user_id addition must not break the
    // documented inheritance behavior for the SAME user.
    const cfg = buildConfig();
    const p = writeCfg("sec-session-sameuser.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    fs.rmSync(path.join(LOG_DIR, "requests.jsonl"), { force: true });
    setReply(JSON.stringify({ complexity: "hard", clarity: "clear", assumptions: [] }));

    const bodyA = msgBody({ messages: [{ role: "user", content: "Refactor the auth module" }] });
    bodyA.metadata = { user_id: "same-user" };
    await post("/v1/messages", bodyA);

    setReply(JSON.stringify({ complexity: "medium", clarity: "clear", assumptions: [] }));
    const bodyB = msgBody({
      messages: [
        { role: "user", content: "Refactor the auth module" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "yes" },
      ],
    });
    bodyB.metadata = { user_id: "same-user" };
    await post("/v1/messages", bodyB);

    const calls = fs.readFileSync(path.join(LOG_DIR, "requests.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.url === "/v1/messages" && e.model && !e.model.startsWith("classifier-"));
    eq(calls.length, 2, "two chat calls");
    const turn2Model = calls[1]?.model;
    // Same user, same first message -> inheritance kicks in -> tier-hard
    ok(turn2Model === "tier-hard", `turn 2 inherits tier-hard from session (got ${turn2Model})`);
    await stopRouter();
  });

  // --------- S7b: the /logs dashboard tail redacts what stdout redacts ---------
  console.log("\n== suite: S7b — /logs tail redaction ==");

  await test("S7b: /logs tail redacts secret-shaped prompt content", async () => {
    // The dashboard's router-log card mirrors the terminal. Debug mode
    // previews the last user turn — a pasted API key in that preview must
    // reach NEITHER stdout NOR the /logs ring it is served from.
    const cfg = buildConfig({ debug: true });
    const p = writeCfg("sec-logs-redact.json", cfg);
    await startRouter(p, { ROUTES_PATH: path.join(LOG_DIR, "no-routes.md") });
    setReply(JSON.stringify({ complexity: "medium", clarity: "clear", assumptions: [] }));
    const FAKE = "sk-ant-api03-fakekeydeadbeefdeadbeef998877";
    await post("/v1/messages", msgBody({
      messages: [{ role: "user", content: "store this key " + FAKE + " thanks" }],
    }));
    const res = await fetch(`http://localhost:${ROUTER_PORT}/logs`);
    eq(res.status, 200, "status 200");
    const j = await res.json();
    ok(Array.isArray(j.lines) && j.lines.length > 0, "ring captured output");
    const flat = (j.lines || []).map((l) => l.text).join("\n");
    ok(!flat.includes(FAKE), "the pasted key never appears in /logs");
    ok(flat.includes("[REDACTED]"), "redaction marker present instead");
    await stopRouter();
  });

  // --------- summary ---------
  console.log("\n=========================================");
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(` - ${f.label}`);
  }
  await stopAll(); // kill the mock before exiting — process.exit alone can orphan it
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("security test suite crashed:", e);
  await stopAll();
  process.exit(1);
});