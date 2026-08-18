#!/usr/bin/env node
/**
 * One-off latency probe: times a minimal /v1/messages round-trip per
 * model against the z.ai Anthropic-compatible endpoint. Mirrors the
 * router's key resolution (env > keystore > .env) and never prints
 * the key itself.
 *
 *   node test/latency-probe.js [model ...]
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

function resolveKey() {
  if (process.env.ROUTE_API_KEY) return process.env.ROUTE_API_KEY;
  try {
    const ks = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".claude-smart-router", "keys.json"), "utf8")
    );
    if (ks.route) return ks.route;
  } catch (_) { /* no keystore */ }
  for (const dir of [process.cwd(), __dirname + "/.."]) {
    try {
      const m = fs.readFileSync(path.join(dir, ".env"), "utf8").match(/^ROUTE_API_KEY=(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch (_) { /* no .env here */ }
  }
  return null;
}

const BASE_URL = "https://api.z.ai/api/anthropic";
const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["glm-4.7-flash", "glm-4.7", "glm-5", "glm-5.2", "glm-1"];
const ROUNDS = 2;

(async () => {
  const key = resolveKey();
  if (!key) {
    console.error("no ROUTE_API_KEY found (env / keystore / .env)");
    process.exit(1);
  }
  for (const model of MODELS) {
    for (let i = 1; i <= ROUNDS; i++) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${BASE_URL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 32,
            messages: [{ role: "user", content: "Reply with the single word: ok" }],
          }),
        });
        const data = await res.json();
        const ms = Date.now() - t0;
        const served = data.model || (data.error ? data.error.message : "");
        console.log(`${model.padEnd(15)} run${i}  HTTP ${res.status}  ${String(ms).padStart(5)}ms  ${String(served).slice(0, 60)}`);
      } catch (e) {
        console.log(`${model.padEnd(15)} run${i}  FAILED  ${e.message}`);
      }
    }
  }
})();
