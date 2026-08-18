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

Install and run in any directory:

```bash
npm install -g claude-smart-router
claude-smart-router key set route        # paste your GLM key (input hidden)
claude-smart-router key set classifier   # same key if classifier is GLM
claude-smart-router
```

With keys in the keystore and no `config.json` anywhere, the router
starts on the **bundled default config** (GLM tiers, port 8787) — zero
files needed. Drop a `config.json` in your working directory whenever
you want different models or providers.

Keys typed via `key set` are stored in `~/.claude-smart-router/keys.json`
— outside every project directory, like Claude Code's own credentials —
and take precedence over `.env`. `key list` shows what's stored (masked),
`key remove <name>` deletes one. Get the key from your z.ai account: the
default tiers all point at `https://api.z.ai/api/anthropic`, and models
are billed against that platform's balance.

Or straight from a checkout — same flow, keys still come from the
keystore:

```bash
node router.js
```

### Packing, installing, uninstalling

To try the package exactly as it would ship to npm — the tarball `npm pack`
produces is byte-for-byte what `npm publish` uploads:

```bash
npm pack                       # -> claude-smart-router-<version>.tgz
npm install -g ./claude-smart-router-1.2.3.tgz
```

You can also install straight from the checkout, no tarball needed:

```bash
npm install -g .
```

Upgrading is the same command re-run — npm replaces the previous version.
To check what's actually inside a tarball before installing:

```bash
tar -tzf claude-smart-router-1.2.3.tgz
```

To remove it entirely:

```bash
npm uninstall -g claude-smart-router
```

Uninstalling only removes the package. Your keys
(`~/.claude-smart-router/keys.json`), any project-local `config.json` /
`.env`, and the `ANTHROPIC_BASE_URL` edit in `~/.claude/settings.json`
survive — delete/undo those manually for a full cleanup. Also remember to
fully restart VS Code (or any running Claude Code session) after
uninstalling so it stops pointing at the dead proxy.

`config.json` is only for changing what the bundled defaults don't cover.
Copy `config.example.json` to `config.json` in your working directory when
you want different models or providers. API keys don't belong in it — they
resolve from the keystore/env first; a per-route `apiKey` in config works
as an explicit override. What it controls:

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
[router] listening on http://127.0.0.1:8787 (bind: 127.0.0.1)
[router] super_easy -> glm-4.7-flash @ https://api.z.ai/api/anthropic
[router] easy -> glm-4.7-flash @ https://api.z.ai/api/anthropic
[router] medium -> glm-5 @ https://api.z.ai/api/anthropic
[router] hard -> glm-5.2 @ https://api.z.ai/api/anthropic
[router] super_hard -> glm-5.2 @ https://api.z.ai/api/anthropic
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
- `GET /map` — inspect the current repo map (see below).
- `POST /map/refresh` — rebuild the repo map cache. Call after `git pull`,
  reorg, or any time the cached map has gone stale.

Config, `.env`, and `ROUTES.md` are resolved from the **current working
directory** first, then next to `router.js` — so a global install finds
your files wherever you run it. Explicit env vars (`ROUTER_CONFIG`,
`ROUTER_ENV_PATH`, `ROUTES_PATH`) always win. API keys resolve as
**environment variables > `key set` keystore > `.env` > config.json**.
Invalid configs (bad JSON, missing routes/model/baseUrl) fail at startup
with a list of exactly what's wrong instead of erroring per-request later.

## Repo map (per-session project overview)

The router injects a compact file-tree + exports summary into the first
user message of every request in a session, so the model knows what project
it's in without you having to `@`-mention files. This is the same idea as
Aider's repo map or Cursor's `@Codebase`, but deliberately minimal: no tool
interception (Claude Code's own Read/Edit tools handle file access). It
exists for users who don't habitually `@`-mention files — if you do, you
can disable it.

**Why re-inject on every request?** The Messages API is stateless: Claude
Code owns the conversation and resends its clean copy on every request. A
one-shot injection would be seen by exactly one model call and then
vanish. So instead the router **freezes** the map (plus pinned files) per
session on the first turn whose classification clears `minComplexity`, and
appends the *same frozen bytes* to the session's first user message on
every subsequent request. Because the injected text never changes and
always lands in the same message, it sits inside the prompt-cached prefix —
after the first write, later turns pay cache-read price (~10% of base
input) for the map, not full price.

The map cache itself is TTL-based — no file watcher, because tokens are
paid at injection time, not cache-update time. TTL rebuilds and
`POST /map/refresh` only affect sessions **frozen afterward**; a live
session's frozen bytes are never rewritten (that would break its cache
prefix on every turn the map changed). If the router restarts or the
session store evicts a live session (rare — see limitations below), the
next qualifying turn re-freezes from the current map and the router logs
it; that costs one cache break, after which the new bytes are stable again.

```json
"repoMap": {
  "enabled": true,
  "root": "./",
  "maxTokens": 2000,
  "minComplexity": "medium",
  "ttlMs": 10000,
  "pinnedFiles": [],
  "compactAfter": { "super_hard": 4, "hard": 5, "medium": 6 },
  "writeToFile": null
}
```

- `enabled` (default `true`) — set `false` to turn the feature off entirely.
- `root` (default `./`, override with `ROUTER_PROJECT_ROOT` env var) — the
  directory to walk. Defaults to wherever you started the router.
- `maxTokens` (default `2000`) — hard cap on map size. The walk stops as
  soon as the serialized map crosses ~4 × this number of bytes, and the
  header is marked `TRUNCATED` so the model knows the tree is partial.
- `minComplexity` (default `medium`) — the map freezes on the first turn
  *classified* at or above this level, so greetings ("hi") and quick
  questions don't pay for it. Gating uses the classified complexity, not
  the tool-floor-bumped one (Claude Code always sends tools, so the bumped
  value is always ≥ medium and would make the gate meaningless).
- `ttlMs` (default `10000`) — how long the cached map stays fresh before
  being rebuilt on next access. Lower = fresher but more walks; higher =
  fewer walks but staler.
- `pinnedFiles` (default `[]`) — specific files injected verbatim alongside
  the map, frozen into the session at the same moment. Useful for project
  context Claude Code doesn't auto-load (note: `CLAUDE.md` IS auto-loaded
  by Claude Code, so don't duplicate it here). Each file is capped at 8KB
  to prevent budget blowup. Paths are relative to `root`; missing files
  are skipped with a warning.

```json
"pinnedFiles": ["README.md", "AGENTS.md", "src/index.ts"]
```

`GET /map` shows you exactly what gets injected; `POST /map/refresh` forces
an immediate rebuild (rarely needed thanks to TTL).

What gets extracted: file paths (relative to `root`) plus top-level exported
names — `function`, `class`, `const` for JS/TS; `def`/`class` for Python;
`func`/`type` for Go; `fn`/`struct`/`enum` for Rust; equivalents for Java,
Kotlin, Ruby, PHP, and shell. Skipped directories include `node_modules`,
`.git`, `dist`, `build`, `.next`, `__pycache__`, `venv`, `target`, `vendor`,
and similar. Files larger than 64KB are only scanned for exports in their
first 64KB — exports are at the top, no need to read whole files.

### Auto-compact (reclaim tokens after N user turns)

After 4-6 *real* user turns, the full map is no longer useful — the model
has already Read the files it needs — so the router switches to a one-liner
variant ("15 files, key: main.js, util.js, ...") for the rest of the
session:

```json
"compactAfter": { "super_hard": 4, "hard": 5, "medium": 6 }
```

- Thresholds count **text-bearing user turns only**. In Claude Code every
  tool round-trip is a `user` message; counting those would compact a
  super_hard agentic loop after ~2 tool calls, right when the map is most
  useful. A message combining tool results + typed text does count
  (genuine user input).
- The tier is **frozen at freeze time** (the session's classified
  complexity on the turn that froze the map), so the threshold can't
  flip-flop if a follow-up classifies differently. Set a tier to `0` to
  disable compaction for it.
- Switching variants rewrites the injected prefix exactly **once** (a
  single cache break at the crossing turn); the compact bytes are just as
  stable afterward. Pinned files are never compacted.

Note: this is NOT Claude Code's `/compact` — the router cannot trigger that
(it's a client-side operation). This is the router shrinking its OWN
injected content. For full conversation compaction, run `/compact` in
Claude Code directly.

### Writing the map to a file (CLAUDE.md integration)

If you prefer the map to be a visible, version-controllable artifact — or
if you want it included on every turn via CLAUDE.md's `@path` inclusion —
set `writeToFile`:

```json
"writeToFile": ".router/repo-map.md"
```

The router writes the map to this file on every rebuild (startup, TTL
expiry, or `POST /map/refresh`). To include it in every session's system
context, add this line to your `CLAUDE.md`:

```markdown
@.router/repo-map.md
```

**Trade-off**: a CLAUDE.md include is charged at full input price on every
turn, while router injection sits inside the cached prefix (~10% per turn
after the first write). If you `@include` the file in CLAUDE.md, set
`repoMap.enabled = false` to avoid paying for the map twice.

When to use which:

- **Router injection only** (default): cheapest per turn, map visible all
  session. Best for most projects.
- **CLAUDE.md inclusion only** (`enabled: false`, `writeToFile: "..."`):
  version-controllable, visible to every tool that reads CLAUDE.md — but
  full input price every turn. Worth it for small maps you want in git.
- **Both** (not recommended): double token cost, no additional benefit.

## Known limitations

- Session tracking is approximated by hashing your system prompt + first
  message. Two unrelated sessions with an identical system prompt and first
  message could share routing state. Fine for typical single-session use.
- Repo-map re-injection assumes the upstream honors prompt caching. On a
  non-caching Anthropic-compatible endpoint, the map is charged at full
  input price on every request — lower `repoMap.maxTokens` if your
  upstream doesn't cache.
- If the router restarts or a live session is evicted from the session
  store mid-conversation, the next qualifying turn re-freezes the repo
  map from the current tree. If the tree changed, that rewrites the
  injected bytes once (a single cache break). A tool-result-only turn
  arriving right after the loss briefly carries no map until the next
  text turn re-qualifies.
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
suite (`node test/run-tests.js` — 104 assertions across repo-map lifecycle, JSON mode, keyword
mode, Ollama, fallbacks, env overrides, auth, and error paths; plus
`node test/extra-probes.js` for gzip passthrough and concurrency).

## Testing

```bash
npm test
```

This runs `test/run-tests.js` (the main e2e suite — boots the router against
mock Anthropic- and Ollama-shaped backends and asserts on what actually got
forwarded) followed by `test/extra-probes.js` (gzip header-stripping and a
20-way concurrency smoke test). Both spawn `test/mock-backends.js`
automatically; you don't run it directly.

`test/latency-probe.js` is a separate, manual one-off — it hits the real
z.ai endpoint with a live API key to compare per-tier latency and is not
part of `npm test` or CI (it costs real request quota and needs a real key
in `ROUTE_API_KEY`, the keystore, or `.env`):

```bash
node test/latency-probe.js glm-4.7 glm-5.2
```
