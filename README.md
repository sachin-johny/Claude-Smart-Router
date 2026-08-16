# claude-smart-router

A local proxy for Claude Code that classifies each request and routes it to
the right backend — GLM, Claude, Ollama, or anything else that speaks the
Anthropic Messages API — instead of you manually switching models.

## What it does

1. **5-tier complexity routing**: `super_easy → easy → medium → hard → super_hard`,
   each mapped to whatever backend/model you configure.
2. **Context inheritance**: short follow-ups ("yes", "try now?") inherit the
   complexity of the ongoing task instead of being misclassified as trivial.
3. **Tool-aware floor**: when a request includes tool definitions, complexity
   is bumped to at least `tools.minComplexity` (default `medium`) — cheap
   models tend to be worse at safe tool use, so this is a guardrail.
4. **Auto-clarification**: genuinely ambiguous prompts get a short block of
   stated assumptions appended — your original message is never edited, and
   the note only appears on the turn that triggered it, not on every
   follow-up afterward.
5. **Customizable classifier prompt** via `ROUTES.md` — edit the triage
   instructions without touching code.
6. Supports **Ollama** as a free local classifier/backend, and Claude Code
   **OAuth tokens** (`sk-ant-oat...`) in addition to plain API keys.

Zero npm dependencies — Node.js 18+ only (uses global `fetch`).

## Setup

Install and run in any directory (config is read from where you run it):

```bash
npm install -g claude-smart-router
claude-smart-router
```

Or straight from a checkout:

```bash
cp config.example.json config.json
node router.js
```

Fill in `config.json`:

- `classifier` — cheap/fast model used to triage every request (default:
  GLM's flash tier). Point this at Ollama (`"baseUrl": "http://localhost:11434"`)
  if you want triage to cost nothing.
- `routes.super_easy` ... `routes.super_hard` — one backend per tier. Point
  the cheap tiers at GLM and the hard tiers at Claude, or mix in Ollama/other
  providers.
- `tools.minComplexity` — floor applied whenever a request has tool
  definitions attached (default `"medium"`).
- `costWeights` — logged per-request for visibility; not enforced as a hard
  budget in this version.
- `routerToken` — optional. If set, the proxy requires
  `Authorization: Bearer <token>` on every request. Leave `null` for local
  single-user use.

Then run it:

```bash
node router.js
```

You'll see something like:

```text
[router] loaded routes template from ./ROUTES.md
[router] listening on http://localhost:8787
[router] super_easy -> glm-4.7-flash @ https://api.z.ai/api/anthropic
[router] easy -> glm-4.7-flashx @ https://api.z.ai/api/anthropic
[router] medium -> glm-5 @ https://api.z.ai/api/anthropic
[router] hard -> glm-5.2[1m] @ https://api.z.ai/api/anthropic
[router] super_hard -> glm-5.2[1m] @ https://api.z.ai/api/anthropic
[router] classifier -> glm-4.7-flash @ https://api.z.ai/api/anthropic
[router] clarify=true
[router] routesTemplate=ROUTES.md (keyword mode)
```

## Wiring into Claude Code (VS Code extension or CLI)

Claude Code reads `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` at startup.
Edit `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8787",
    "ANTHROPIC_AUTH_TOKEN": "local-router"
  }
}
```

The auth token value only matters if you set `routerToken` in `config.json` —
otherwise it's ignored, and the router uses the real per-backend API keys
from your config. **Fully restart VS Code** after editing this file.

## Customizing the classifier prompt (ROUTES.md)

If `ROUTES.md` exists next to `router.js` and contains a `{MESSAGE}`
placeholder, the router uses it instead of the built-in JSON-based prompt.
This mode returns a single complexity keyword rather than
complexity+clarity+assumptions — so **auto-clarification is only active in
the built-in JSON mode**, not when a custom `ROUTES.md` is in use. Delete or
rename `ROUTES.md` if you want clarification back.

For follow-up messages, the router builds a `Context: ... \n---\n Message: ...`
block (matching the pattern `ROUTES.md`'s own examples document) so the
classifier can see what a short reply like "yes" is actually replying to.

## API key resolution

Keys can live in a `.env` file (copy [.env.example](.env.example) to `.env`)
instead of `config.json` — the router loads it automatically at startup, and
the file is git-ignored. Real environment variables always win over `.env`
values. Resolution order, later overrides earlier:

1. `config.json` (`classifier.apiKey`, `routes.<tier>.apiKey`)
2. `.env` file or environment: `ROUTE_API_KEY` → **every** tier's backend
3. `CLASSIFIER_API_KEY` → classifier backend
4. `ROUTE_<TIER>_API_KEY` (e.g. `ROUTE_HARD_API_KEY`) → that tier's backend
5. `ROUTER_TOKEN` → overrides `routerToken`

For an all-GLM setup, `.env` is just two lines:

```bash
ROUTE_API_KEY=your_glm_key
CLASSIFIER_API_KEY=your_glm_key
```

Set `ROUTER_ENV_PATH` if you want the env file somewhere other than next to
`router.js`.

## Tuning

- `skipClassifyMinWords` (default `4`) — messages shorter than this skip
  triage; they either default to `super_easy` or inherit complexity from
  session context if one exists.
- `clarify` — set `false` to disable assumption-appending while keeping
  complexity routing (JSON mode only).
- `upstreamTimeoutMs` (default `120000`) — abort a stuck upstream call.
- `maxSessions` (default `500`) — cap on in-memory session tracking; oldest
  entries are evicted once exceeded.
- `tools.model` — force a specific model whenever tools are present,
  bypassing tier routing entirely.
- `host` (default `127.0.0.1`) — address to bind. The proxy injects your
  API keys into upstream requests, so it stays loopback-only unless you
  deliberately set `0.0.0.0` (do that only together with `routerToken`).
- `maxBodyMb` (default `20`) — request bodies larger than this are
  rejected with `413`.
- `GET /health` — lightweight liveness endpoint (uptime + session count),
  handy for process managers and uptime checks.

Config, `.env`, and `ROUTES.md` are resolved from the **current working
directory** first, then next to `router.js` — so a global install finds
your files wherever you run it. Explicit env vars (`ROUTER_CONFIG`,
`ROUTER_ENV_PATH`, `ROUTES_PATH`) always win. Invalid configs (bad JSON,
missing routes/model/baseUrl) fail at startup with a list of exactly
what's wrong instead of erroring per-request later.

## Known limitations

- Session tracking is approximated by hashing your system prompt + first
  message. Two unrelated sessions with an identical system prompt and first
  message could share routing state. Fine for typical single-session use.
- Classification looks at your latest message plus a short summary of
  recent assistant replies, not the full conversation — usually enough to
  judge complexity, but very context-dependent requests may be misjudged.
- Cost weights are logged, not enforced — there's no hard budget cutoff.
- Single-process; no clustering. Fine for a personal proxy's load.

## Changes from earlier version (fixes applied)

A few correctness issues were found and fixed in this pass:

1. **Stale clarification notes no longer leak into later turns.** Auto-
   clarification now only fires on the turn that generated it — previously,
   inheriting a routing decision on a continuation or short follow-up also
   inherited (and re-appended) the original ambiguity note on every
   subsequent turn of the session, including onto tool-result-only messages
   that had nothing to do with the original ambiguity.
2. **Tool-floor bumps no longer permanently mutate session state.**
   The session now stores the *classified* complexity; the tool-floor bump
   applies to routing for that turn only. Previously the bumped value was
   what got stored, so a floor bump on one turn silently rewrote history
   for turns after it (copying the decision object alone didn't fix this —
   the copy was made *before* the bump was applied to it).
3. **`/v1/messages/count_tokens` now correctly passes through** instead of
   being misrouted as a full chat request. The passthrough check used
   `startsWith("/v1/messages")`, which also matched the count_tokens path;
   it now requires an exact match.
4. **Passthrough responses strip `content-encoding`/`content-length`/
   `transfer-encoding` headers** before forwarding — `fetch()` transparently
   decompresses gzip/deflate bodies, so forwarding the original encoding
   headers could make the client try to decode an already-decoded body.
5. **`ROUTES.md`'s documented `Context: ... / Message: ...` format is now
   actually built** for follow-ups in keyword mode — previously the router
   only substituted `{MESSAGE}` and appended system context separately,
   never producing the context-aware shape the template's own examples
   describe.
6. **Ollama classifier in JSON mode now receives the JSON schema.** The
   Ollama branch of `callClassifier` sent only the user message to
   `/api/generate`, silently dropping `payload.system` — where the built-in
   JSON triage prompt keeps its format instructions. The local model
   replied freeform, `JSON.parse` failed, and *every* request silently
   degraded to `medium`. The system text is now flattened into the prompt.
7. **Legacy `light`/`heavy` configs route correctly.** The old
   `LEGACY_TIER_MAP` was looked up in the wrong direction (by complexity
   value, though its keys were route names), so it never matched; a `hard`
   request on a `{light, heavy}` config fell through the neighbor-chain and
   landed on `light` — the cheap tier — for expensive work. It's now a
   proper complexity→route mapping (`easy`→`light`, `medium`+→`heavy`).

Issues #1–#5 were fixed before this pass; #6 and #7 were found by the test
suite (`node test/run-tests.js` — 74 assertions across JSON mode, keyword
mode, Ollama, fallbacks, env overrides, auth, and error paths; plus
`node test/extra-probes.js` for gzip passthrough and concurrency).
