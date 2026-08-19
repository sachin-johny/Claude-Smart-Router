#!/usr/bin/env node
/**
 * Mock backends for testing claude-smart-router.
 *
 * Starts two HTTP servers:
 *   :9911  Anthropic-Messages-API-shaped backend (classifier + route tiers)
 *          - Every request is recorded to disk (headers excluded keys).
 *          - /v1/messages          -> chat endpoint (records, replies)
 *          - /v1/messages/count_tokens -> passthrough-shaped endpoint
 *          - anything else         -> 200 {"path": ...} (for passthrough tests)
 *   :9912  Ollama-shaped backend (/api/chat + /api/generate)
 *
 * Behavior is driven by control files in LOG_DIR (re-read on every request,
 * so the test runner can change behavior between requests without restarts):
 *   CLASSIFIER_REPLY   - raw text returned from /v1/messages when the body
 *                        matches the classifier model (default: a valid JSON
 *                        triage object). A "keyword:xxx" prefix sends back a
 *                        bare complexity word (ROUTES.md mode).
 *   TIER_STATUS        - HTTP status the chat endpoint returns (default 200)
 * Ports/LOG_DIR come from env at startup (PORT_AN/PORT_OL/LOG_DIR).
 * Requests are appended as JSON lines to $LOG_DIR/requests.jsonl so the test
 * runner can assert on exactly what the router forwarded.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT_AN = parseInt(process.env.PORT_AN || "9911", 10);
const PORT_OL = parseInt(process.env.PORT_OL || "9912", 10);
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "requests.jsonl");

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function logRequest(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

// Dynamic behavior is controlled via files in LOG_DIR (re-read per request),
// NOT env vars — the runner can't mutate a child's env after spawn.
function readControl(name, fallback) {
  try {
    const p = path.join(LOG_DIR, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  } catch (_) { /* ignore */ }
  return fallback;
}

// The default classifier reply: valid JSON triage result.
const DEFAULT_CLASSIFIER_REPLY = JSON.stringify({
  complexity: "medium",
  clarity: "clear",
  assumptions: [],
});

function makeAnthropicServer() {
  return http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (_) { /* passthrough bodies may not be JSON */ }

    const isClassifierCall =
      req.url === "/v1/messages" &&
      typeof body.model === "string" &&
      body.model.startsWith("classifier-");

    logRequest({
      server: "anthropic",
      method: req.method,
      url: req.url,
      model: body.model || null,
      authHeader: req.headers["x-api-key"] || req.headers["authorization"] || null,
      anthropicBetaHeader: req.headers["anthropic-beta"] || null,
      userAgent: req.headers["user-agent"] || null,
      hasTools: Array.isArray(body.tools) && body.tools.length > 0,
      system: body.system ?? null,
      messages: body.messages || null,
      body: body,
    });

    if (isClassifierCall) {
      let reply = readControl("CLASSIFIER_REPLY", DEFAULT_CLASSIFIER_REPLY);
      // keyword:super_hard -> reply with the bare keyword (ROUTES.md mode)
      if (reply.startsWith("keyword:")) reply = reply.slice("keyword:".length);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_classifier",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: reply }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 10 },
        })
      );
      return;
    }

    if (req.url === "/v1/messages") {
      const status = parseInt(readControl("TIER_STATUS", "200"), 10);
      if (body.stream) {
        res.writeHead(status, { "content-type": "text/event-stream" });
        // Usage-bearing events shaped like the real Messages API, so the
        // router's credit tracking can read tokens off streams:
        // message_start carries input/cache tokens, the final
        // message_delta carries output tokens.
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 1 },
            },
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            type: "content_block_delta",
            delta: { type: "text_delta", text: `reply-from-${body.model}` },
          })}\n\n`
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 50 },
          })}\n\n`
        );
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        res.end();
      } else {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_tier",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: `reply-from-${body.model}` }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 50 },
          })
        );
      }
      return;
    }

    // Any other path — passthrough-shaped response (with a gzip marker so we
    // can verify header stripping: fetch decompresses, so content-encoding
    // must not be forwarded).
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ passthrough: req.url }));
  });
}

function makeOllamaServer() {
  return http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (_) {}

    logRequest({
      server: "ollama",
      method: req.method,
      url: req.url,
      model: body.model || null,
      body,
    });

    if (req.url === "/api/generate") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: body.model,
          response: readControl("CLASSIFIER_REPLY", "medium"),
          done: true,
        })
      );
      return;
    }

    if (req.url === "/api/chat") {
      if (body.stream) {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(
          JSON.stringify({ model: body.model, message: { role: "assistant", content: `reply-from-${body.model}` }, done: false }) + "\n"
        );
        res.write(JSON.stringify({ model: body.model, message: { role: "assistant", content: "" }, done: true }) + "\n");
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: body.model,
            message: { role: "assistant", content: `reply-from-${body.model}` },
            done: true,
          })
        );
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

const anServer = makeAnthropicServer();
const olServer = makeOllamaServer();
anServer.listen(PORT_AN, () =>
  console.log(`[mock] anthropic-shaped backend on :${PORT_AN}`)
);
olServer.listen(PORT_OL, () =>
  console.log(`[mock] ollama backend on :${PORT_OL}`)
);

function shutdown() {
  anServer.close();
  olServer.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
