#!/usr/bin/env node
/**
 * One-off probes: passthrough header stripping (gzip) + concurrency smoke.
 * Run: node test/extra-probes.js
 */
const { spawn } = require("child_process");
const zlib = require("zlib");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOG_DIR = path.join(__dirname, "logs");

// --- 1. gzip passthrough probe: upstream replies gzipped w/ headers ---
const gzBody = JSON.stringify({ gzipped: true, note: "this body was gzip-encoded" });
const gz = zlib.gzipSync(gzBody);

const upstream = http.createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(gz.length),
    });
    res.end(gz);
    return;
  }
  // slow endpoint for timeout probe (unused by default)
  if (req.url === "/slow") {
    setTimeout(() => res.end("{}"), 30_000);
    return;
  }
  res.writeHead(404);
  res.end("{}");
});

let routerProc = null;
async function main() {
  await new Promise((r) => upstream.listen(9950, r));
  console.log("[probe] gzipping upstream on :9950");

  const cfg = {
    port: 9878,
    classifier: { baseUrl: "http://localhost:9950", apiKey: "k", model: "classifier-x" },
    routes: { easy: { baseUrl: "http://localhost:9950", apiKey: "k", model: "m" } },
  };
  const cfgPath = path.join(LOG_DIR, "config-probe.json");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  routerProc = spawn(process.execPath, [path.join(ROOT, "router.js")], {
    env: { ...process.env, ROUTER_CONFIG: cfgPath, ROUTES_PATH: path.join(LOG_DIR, "none.md"), ROUTER_ENV_PATH: path.join(LOG_DIR, "no-env-file"), PORT: "9878" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((r) => {
    let out = "";
    routerProc.stdout.on("data", (d) => {
      out += d;
      if (out.includes("listening")) r();
    });
  });
  console.log("[probe] router on :9878");

  // GET /v1/models through the router's passthrough branch
  const res = await fetch("http://localhost:9878/v1/models");
  const headers = Object.fromEntries(res.headers.entries());
  const text = await res.text();

  const findings = [];
  const enc = res.headers.get("content-encoding");
  const len = res.headers.get("content-length");
  if (enc) findings.push(`FAIL: content-encoding forwarded (${enc}) — client would try to gunzip an already-decoded body`);
  else findings.push("PASS: content-encoding stripped");
  if (len === String(gz.length)) findings.push(`FAIL: stale content-length forwarded (${len}) — length now mismatches decoded body`);
  else findings.push("PASS: content-length not stale");
  try {
    const parsed = JSON.parse(text);
    if (parsed.gzipped === true) findings.push("PASS: body decoded and intact");
    else findings.push(`FAIL: unexpected body: ${text.slice(0, 100)}`);
  } catch (e) {
    findings.push(`FAIL: body not valid JSON after proxying: ${text.slice(0, 100)}`);
  }

  // --- 2. concurrency smoke: 20 parallel /v1/messages requests ---
  const cfg2 = JSON.parse(fs.readFileSync(path.join(LOG_DIR, "config.json"), "utf8"));
  // reuse main mock backends from the suite if still up; else boot quickly:
  const { spawn: sp } = require("child_process");
  const mock = sp(process.execPath, [path.join(__dirname, "mock-backends.js")], {
    env: { ...process.env, LOG_DIR },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 800));
  fs.writeFileSync(path.join(LOG_DIR, "CLASSIFIER_REPLY"), JSON.stringify({ complexity: "medium", clarity: "clear", assumptions: [] }));
  fs.writeFileSync(path.join(LOG_DIR, "TIER_STATUS"), "200");

  const cfgPath2 = path.join(LOG_DIR, "config-conc.json");
  fs.writeFileSync(cfgPath2, JSON.stringify(cfg2));
  routerProc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  routerProc = spawn(process.execPath, [path.join(ROOT, "router.js")], {
    env: { ...process.env, ROUTER_CONFIG: cfgPath2, ROUTES_PATH: path.join(LOG_DIR, "none.md"), ROUTER_ENV_PATH: path.join(LOG_DIR, "no-env-file"), PORT: "9878" },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 800));

  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      fetch("http://localhost:9878/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x", max_tokens: 10, messages: [{ role: "user", content: `concurrent request number ${Math.random()}` }] }),
      }).then(async (r) => ({ status: r.status, body: await r.text() }))
    )
  );
  const ms = Date.now() - t0;
  const okCount = results.filter((r) => r.status === 200 && r.body.includes("reply-from")).length;
  findings.push(`${okCount === 20 ? "PASS" : "FAIL"}: concurrency — ${okCount}/20 parallel requests OK in ${ms}ms`);

  console.log("\n== probe results ==");
  for (const f of findings) console.log("  " + f);

  routerProc.kill("SIGTERM");
  mock.kill("SIGTERM");
  upstream.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  if (routerProc) routerProc.kill("SIGTERM");
  upstream.close();
  process.exit(1);
});
