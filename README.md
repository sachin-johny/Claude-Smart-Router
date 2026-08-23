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
   follow-up afterward. Assumptions coming back from the classifier are
   sanitized first: anything resembling a tool invocation, file path, URL,
   env var, or secret reference is dropped instead of appended.
5. **Customizable classifier prompt** via `ROUTES.md` — edit the triage
   instructions without touching code.
6. Supports **Ollama** as a free local classifier/backend, and Claude Code
   **OAuth tokens** (`sk-ant-oat...`) in addition to plain API keys.
7. **Budget enforcement**: `budgetMax` caps a session's accumulated
   cost-weight spend; breached sessions get downgraded to the cheapest tier
   (or rejected with `budgetReject: true`) instead of burning expensive tiers.
8. **Auto-escalation**: when the chosen upstream fails or 5xx's, the router
   retries once on the next-smarter tier so you don't see the error.
9. **GLM Coding Plan credit tracking**: real 5-hour and weekly plan-credit
   accounting from actual usage, peak/off-peak rates, one-time hints, and a
   `GET /credits` dashboard (see below). An optional overlay can also pull
   your **actual account usage** straight from Z.ai, closing the one blind
   spot the router's own ledger has (traffic that bypasses the proxy).

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
npm install -g ./claude-smart-router-x.x.x.tgz
```

You can also install straight from the checkout, no tarball needed:

```bash
npm install -g .
```

Upgrading is the same command re-run — npm replaces the previous version.
To check what's actually inside a tarball before installing:

```bash
tar -tzf claude-smart-router-x.x.x.tgz
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
- `costWeights` — relative token cost per tier, logged per-request and used
  by `budgetMax` enforcement.
- `budgetMax` / `budgetReject` — cap a session's accumulated cost-weight
  spend. On breach, later requests from that session are downgraded to the
  cheapest tier — or rejected outright when `budgetReject` is `true`.
- `heuristic` (default `true`) — keyword pre-filter that skips the
  classifier call for obviously easy/hard prompts. Set `false` to always
  classify.
- `classifyCacheTtlMs` (default `60000`) — cache classifications by message
  text. Set `0` to disable.
- `compactHintTurns` (default `15`) — inject a one-time hint suggesting
  `/compact` after this many user turns in a session.
- `credits` — GLM Coding Plan credit tracking (see below).
- `routerToken` — optional. If set, the proxy requires
  `Authorization: Bearer <token>` on every request (compared in constant
  time). Leave `null` for local single-user use.
- `rateLimit` — optional per-IP rate limit, e.g. `{ "rpm": 60 }`.
  Requests are counted in a sliding 60s window with `burst` headroom
  (default `rpm`/2); over the limit the proxy answers `429` with a
  `retry-after` header. Off by default — enable it together with
  `routerToken` when binding beyond loopback. `trustXff` (default
  `false`) keys the limit off `X-Forwarded-For` instead of the socket
  address; only enable it behind a reverse proxy you control, since
  otherwise any client can spoof that header.

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
[router] rateLimit=disabled (set rateLimit.rpm in config to enable)
[router] routesTemplate=ROUTES.md (keyword mode)
[router] budgetMax=none (set budgetMax in config.json to enforce)
[router] autoEscalation=enabled (max 1/session, on failure patterns + 5xx)
[router] compactHint=at 15 turns (set compactHintTurns in config.json to adjust)
[router] credits: tracking GLM plan — 2000/5h + 10000/wk, warn at 80%, hints=on, off-peak=0.5x (peak Mon-Fri 14:00-18:00 UTC+8)
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
values. Inline `# comments` are stripped from unquoted values
(`KEY=value # note` → `value`), dotenv-style; quote a value to keep a
literal `#`. Resolution order, later overrides earlier:

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
  deliberately set `0.0.0.0` (do that only together with `routerToken`,
  and add `rateLimit` for anything beyond a trusted LAN).
- Non-`/v1/messages` requests pass through to the `easy` tier's backend
  for an **allowlisted** set of Anthropic endpoints only
  (`/v1/messages/count_tokens`, `/v1/messages/batches[/...]`,
  `/v1/models`). Anything else gets a 404, and paths containing `..` or
  `\` a 400 — the proxy refuses to act as a generic forwarder that
  attaches your API key to arbitrary upstream paths.
- `maxBodyMb` (default `20`) — request bodies larger than this are
  rejected with `413`.
- `GET /health` — lightweight liveness endpoint (uptime, session count,
  escalation count, budget state, credit percentages, peak-hour flag,
  classifier circuit breaker state, in-flight count, and skip stats),
  handy for process managers and uptime checks.
- `GET /credits` — live GLM Coding Plan usage: 5h/weekly totals and
  percentages, the weekly reset instant, when the 5h window replenishes,
  and peak-hour state with the next change as an absolute instant (see
  below). Also carries `zaiAccount` when the
  [account-usage overlay](#zai-account-usage-overlay-optional--ground-truth-from-your-account)
  is enabled (`null` otherwise).
- `POST /credits/refresh` — forces an immediate z.ai account-usage poll,
  bypassing the interval. Returns the same shape as `GET /credits`. No-ops
  with `{ enabled: false }` if `credits.zaiAccountUsage` isn't on.
- `GET /map` — inspect the current repo map (see below).
- `POST /map/refresh` — rebuild the repo map cache. Call after `git pull`,
  reorg, or any time the cached map has gone stale.
- `GET /logs` — tail of the router's own console output (last 400 lines,
  the same redaction as stdout). Supports `?after=<seq>` so clients append
  incrementally; the dashboard's "Router log" card uses this to mirror the
  terminal live. Set `"dashboard": { "debug": true }` in `config.json` to
  capture the per-request debug trace in the dashboard log **without**
  printing it to the terminal (or env `DASHBOARD_DEBUG=1`) — separate from
  the main `debug` flag, which prints and mirrors.
- `GET /dashboard` — self-contained read-only HTML dashboard. Zero external
  resources, no build step, no new files in the package (the HTML lives
  inside `router.js`). Gated by `routerToken` + `rateLimit` like every other
  route — loopback-only by default. The router logs the dashboard URL on
  startup. To auto-launch a browser on boot, set
  `"openDashboardOnStart": true` in `config.json` (off by default; silently
  no-ops on headless boxes without `$DISPLAY`/`$WAYLAND_DISPLAY`).
  Poll cadence: `/health` every 8s, `/credits` every 15s, `/logs` every 3s;
  `/keys` is fetched once at load (the keystore only changes on restart).
  Everything time-related renders in **your** timezone: the weekly reset
  ("resets Wed, 26 Aug, 21:17 — in 4d 3h"), when the 5h window clears, and
  a compact peak card — on/off pill, "Peak ends / Next peak" countdown, the
  local clock equivalent of the Mon–Fri 14:00–18:00 SGT window, and the
  billing rate in effect (1× in peak, 0.5× off-peak). A "Router log" card
  tails the terminal output next to it. Light and dark themes follow your
  system, with a manual toggle. When the [z.ai account-usage overlay](#zai-account-usage-overlay-optional--ground-truth-from-your-account)
  is enabled, each meter shows the provider's own percentage alongside the
  router's ledger, and a `⟳` button next to the credits header forces an
  immediate refresh outside the normal poll interval.
- `GET /keys` — masked view of the keystore (`route` / `classifier` /
  `router`), same format as `key list`. **Never returns plaintext** —
  defense-in-depth so a leaked dashboard token still can't exfiltrate raw
  API keys.

### Classifier resilience knobs (v1.5.0)

All under `config.classifier.*`, safe defaults so existing configs work unchanged:

- `maxRetries` (default `3`) — total classifier attempts.
- `timeoutMs` (default `8000`) — per-attempt timeout, remote path only.
- `ollamaTimeoutMs` (default `30000`) — separate knob for local models.
- `deadlineMs` (default `15000`, capped at 25% of upstream) — hard
  overall timeout for the classify phase.
- `backoffBaseMs` (default `750`), `backoffMaxMs` (default `5000`),
  `backoffJitter` (default `0.4`, ±40%) — retry delay computation.
- `breakerThreshold` (default `3`, `0` disables) — consecutive failures
  before the circuit breaker opens.
- `breakerCooldownMs` (default `60000`) — cooldown before half-open probe.
- `singleFlight` (default `true`) — dedupe identical in-flight prompts.
- `titleGenSkip` (default `true`) — skip classifier for Claude Code
  title-gen prompts (regex: `<session>...title`).
- `titleGenPattern` — override the title-gen detection regex.
- `compactSkip` (default `true`) — skip classifier for `/compact` prompts
  (regex: `CRITICAL: Respond with TEXT ONLY`).
- `compactPattern` — override the compact detection regex.
- `compactHardMsgThreshold` (default `30`) — messages above this count
  route `/compact` to `hard` instead of `medium` (larger context = harder
  summarization).

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

## Budget enforcement & auto-escalation

`budgetMax` (default `null` = off) turns `costWeights` from a visibility
metric into a cap: each request adds its tier's weight to the session's
running total, and once it crosses `budgetMax`, later requests from that
session are re-routed to the cheapest tier — or rejected with
`budgetReject: true`. A runaway session can no longer silently burn the
expensive tiers.

Auto-escalation covers the other direction: if the chosen upstream errors
or returns a 5xx, the router retries once on the next-smarter tier
(limited per session) instead of surfacing the failure. Escalated retries
are billed to credit tracking too, since the plan charges for them.

## Credit tracking (GLM Coding Plan)

Tracks **real plan credits** — computed from the usage object upstream
reports on every response (JSON bodies, SSE streams via a passive
listener, and escalated retries), never estimated — against the Coding
Plan's two windows:

```json
"credits": {
  "enabled": true,
  "plan": "lite",
  "caps": { "fiveHour": 2000, "weekly": 10000 },
  "weeklyResetAnchor": "2026-08-26T21:17:00+02:00",
  "warnPct": 80,
  "hints": true,
  "peakHint": true,
  "stateFile": "credits-state.json",
  "multipliers": {
    "glm-5.3": { "in": 6.9, "cached": 1.7, "out": 24 },
    "glm-5-turbo": { "in": 5.7, "cached": 1.5, "out": 21 },
    "glm-4.7": { "in": 4.6, "cached": 1.2, "out": 16 }
  }
}
```

- The **5-hour window** is a sliding ledger (credits replenish 5h after
  they're spent). The **weekly window** follows the plan's fixed reset:
  set `weeklyResetAnchor` to your reset time (shown on the Z.AI usage
  page) and the router reports exact resets; without it the week is a
  rolling 7 days (approximate).
- **Peak hours** are Mon–Fri 14:00–18:00 UTC+8; everything else —
  weekends and off-peak hours — bills at 0.5×. Peak state is computed
  from UTC+8 regardless of the machine's timezone.
- **No forced downgrades.** Crossing `warnPct` (default 80%) of either
  window injects a one-time hint per session and logs a warning; a
  peak-hours notice is injected once per session while hints are on. The
  routing decision stays yours.
- `GET /credits` returns the full snapshot; `/health` carries the
  percentages. The ledger persists to `credits-state.json` (debounced,
  flushed on shutdown), so restarts don't lose the weekly total.
  The snapshot's time fields are absolute instants (`weekly.resetsAt`,
  `fiveHour.clearsAt`, `peak.changeAt` / `peak.windowStartAt` /
  `peak.windowEndAt`, plus matching `*InMin` countdowns and `warnPct`)
  so any client — the dashboard, your scripts — can render them in
  whatever timezone it runs in. The dashboard shows the weekly reset
  and the peak windows on your local clock, never Singapore's.
- Known blind spot: traffic that bypasses the router (Z.AI MCP tools,
  direct API clients) is invisible — treat the numbers as a lower bound.
  The overlay below closes this gap.

### Z.ai account-usage overlay (optional — ground truth from your account)

The router's own ledger above is computed from usage objects on responses
that actually went *through* the router — accurate for that traffic, but
blind to anything that didn't. This overlay polls Z.ai's account directly,
so the numbers reflect everything billed to your key, router or not.

```json
"credits": {
  "zaiAccountUsage": true,
  "zaiApiKey": null,
  "zaiAccountUsagePollMs": 25000,
  "zaiAccountUsageTimeoutMs": 8000
}
```

- **Off by default.** Set `zaiAccountUsage: true` to enable — it's an
  extra outbound call on a timer, so it's opt-in rather than silent.
- **API key resolution**: `credits.zaiApiKey` override → `ZAI_API_KEY` env
  var → whichever configured route/classifier already points at a `z.ai`
  baseUrl. For most setups this means no extra config — it reuses your
  existing GLM key.
- **Polls Z.ai's own (undocumented) monitor endpoints** —
  `GET /api/monitor/usage/quota/limit` and `/model-usage`. No official
  docs exist for these; the response shape was reverse-engineered against
  a live account and could change without notice. Each `TOKENS_LIMIT`
  entry reports a **percentage only** (no absolute used/cap), and the
  router infers which entry is the 5-hour vs. weekly window by comparing
  `nextResetTime` — whichever resets sooner is the shorter window.
- **Default poll interval is 25s** (`zaiAccountUsagePollMs`, 10s floor).
  The *first* poll runs before the server starts listening (bounded by
  `zaiAccountUsageTimeoutMs`, default 8s), so the dashboard's very first
  load already has real numbers instead of "not polled yet."
- **Persists to `credits-state.json`.** Every successful poll writes
  through immediately, and a fresh boot seeds from that file before the
  live poll even finishes — a restart never shows a blank overlay.
- **Manual refresh**: `POST /credits/refresh` forces an immediate poll.
  The dashboard's credits card has a small `⟳` button next to the header
  for this — it shows "cached · as of HH:MM" when you're looking at
  disk-seeded data rather than a fresh live poll.
- `GET /credits` includes the overlay under `zaiAccount` (`null` when
  disabled). `zaiAccount.ok: false` means the last poll failed — check
  `zaiAccount.error`, or run with `debug: true` to see the raw response
  in the trace.

## Known limitations

- Session tracking is approximated by hashing your system prompt + first
  message, plus `metadata.user_id` when the client sends one (Claude Code
  does), so different users never collide. Two sessions from the same user
  with an identical system prompt and first message could still share
  routing state. Fine for typical single-session use.
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
- Single-process; no clustering. Fine for a personal proxy's load.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history and every
fix/feature by release.

## License

MIT — see [LICENSE](./LICENSE).
