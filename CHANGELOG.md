# Changelog

All notable changes to `claude-smart-router` are documented here.
See [README.md](README.md) for setup and usage.

## 1.7.3 (Repo map byte-stability)

- **Issue #**: Snapshots the `compactThreshold` numerical value at freeze time so mid-session config updates don't erroneously shrink the repo map prematurely.
- **Issue #2**: Preserves leading whitespace for array-based map content, preventing a prompt cache break when switching from string- to array-based first messages.
- **Issue #3**: `REPO_MAP_CODE_NOEXT` ensures extensionless files like `Makefile` and `Dockerfile` are successfully injected into the repo map and no longer skipped by the compact view.
- **Issue #4**: Expanded testing for post-flip byte stability.

## 1.7.2 (Engineering review fixes)

- **Issue #1**: Fixed keyword-mode assumption parsing casing for proper nouns by preserving original case.
- **Issue #2**: Removed redundant `Message:` label when replacing `{MESSAGE}` to prevent template issues.
- **Issue #3**: Tightened design and refactor rules to use verb-anchors, preventing false positives on questions.
- **Issue #4**: Extracted 588-line dashboard HTML string to its own `dashboard.html` file and added it to package exports.
- **Issue #5**: Stripped `DEBUG` and `DASHBOARD_DEBUG` from parent environment when running tests to ensure isolation.

## 1.7.0 (z.ai account-usage overlay + dashboard refresh)

Adds an optional overlay that reads your **actual account usage** straight
from Z.ai, instead of only the router's own computed ledger — closing the
one blind spot the ledger always had: traffic that bypasses the router
(Z.AI MCP tools, other API clients hitting your key directly).

- **`credits.zaiAccountUsage: true`** turns it on (off by default — it's an
  extra outbound call on a timer, opt-in on purpose). Polls Z.ai's own
  (undocumented) monitor endpoints: `GET /api/monitor/usage/quota/limit`
  and `/model-usage`.
- **Real response shape reverse-engineered from a live account**:
  `{ code, msg, data: { limits: [...] } }`, where each `limits[]` entry is
  either a `TOKENS_LIMIT` (your GLM 5-hour/weekly windows — percentage
  only, no absolute used/cap from this endpoint) or a `TIME_LIMIT` (search
  tool quota: `search-prime`, `web-reader`, `zread`). Since Z.ai doesn't
  name which `TOKENS_LIMIT` entry is the 5-hour window vs the weekly one,
  the router infers it from `nextResetTime` ordering — whichever resets
  sooner is the shorter window. Holds as long as exactly two token windows
  exist on the plan.
- **Auth**: the raw API key works as a Bearer token — a JWT-signing
  detour (Z.ai's `id.secret` HS256 scheme, documented for "higher
  security" use cases) was tried first and ruled out; the actual fix was
  ordering (env-var key overrides must apply *before* the first poll) and
  correctly parsing Z.ai's `{code, msg}` error envelope, which can carry
  an error while HTTP itself returns 200.
- **Polls before the server starts listening.** The first poll is
  `await`-ed (bounded by `credits.zaiAccountUsageTimeoutMs`, default 8s)
  before `server.listen()` runs — the dashboard's very first paint has
  real numbers instead of "not polled yet."
- **Persists to `credits-state.json`.** Every successful poll writes
  through immediately; on restart, the last-known value seeds the
  in-memory cache (marked `cached: true`) before the live poll even
  finishes, so a restart never shows a blank overlay.
- **Poll interval defaults to 25s** (was effectively unbounded before this
  existed) — configurable via `credits.zaiAccountUsagePollMs` (10s floor).
- **Manual refresh**: `POST /credits/refresh` forces an immediate poll
  outside the interval. The dashboard's credits card grows a small `⟳`
  button next to the header — spins while in flight, repaints the card
  from the response, and shows a "cached · as of HH:MM" note when you're
  looking at disk-seeded data rather than a fresh poll. Hidden entirely
  when the overlay isn't enabled.
- **Debug trace no longer includes the dashboard's own polling.** Every
  `/health`, `/credits`, `/logs`, `/keys`, `/dashboard` request the
  dashboard makes to itself was showing up in the `[router:debug] <- GET
  ...` trace, drowning out anything else happening in the log (and, for
  `/logs` specifically, tracing the endpoint that serves the trace about
  itself). These are now excluded from the per-request debug line
  regardless of `debug`/`dashboard.debug` state; real request traffic is
  still traced normally.
- Reminder: `dashboard.debug: true` only adds the trace to the dashboard's
  Router log card *when the top-level `debug` flag is false*. If `debug:
  true` (or `DEBUG=1`) is set, it prints to the terminal **and** mirrors
  to the dashboard regardless of `dashboard.debug` — that flag can't
  suppress terminal output the main flag is causing.

## 1.6.4 (config: dashboard.debug)

New `"dashboard": { "debug": true }` config flag (or `DASHBOARD_DEBUG=1`
env): capture the per-request debug trace in the dashboard's Router log
card **without** printing it to the terminal. `debug: true` still does
both. The boot summary notes when it's active.

## 1.6.3 (dashboard: peak status card, router log tail, saner polling)

The peak card was a full-width week strip at the bottom — lots of space,
little information density. It's now a compact half-width status card
directly under the credits meters, and the terminal itself moved into the
dashboard next to it.

- New `GET /logs` — ring buffer of the router's last 400 console lines
  (boot summary, routing decisions, warnings, debug trace), redacted with
  the same secret patterns as stdout. `?after=<seq>` returns only newer
  lines. The dashboard's "Router log" card tails it every 3s, appends
  incrementally, and sticks to the bottom unless you scroll up — what the
  terminal shows, without the terminal.
- Peak status card: on/off pill, "Peak ends / Next peak" with local clock
  time + countdown, the peak window translated to your timezone
  (e.g. `08:00–12:00 (Europe/Berlin)`), the fixed `Mon–Fri 14:00–18:00`
  SGT window, and the billing rate in effect — 1× full rate in peak,
  0.5× off-peak (weekday nights + weekends), per the Z.AI plan docs.
  The week strip is gone; the card answers the same questions in a
  fraction of the space.
- Poll cadence matches how fast each source actually changes: health 8s,
  credits 15s, log tail 3s. `/keys` is fetched **once** at load — the
  keystore is read at boot and only changes on restart, so re-polling it
  was noise.

## 1.6.2 (dashboard: resets + peak hours in your timezone)

The dashboard showed a bare "Weekly window" percentage with no reset
time, and peak hours only as a countdown against Singapore's clock —
useless for answering "when does my week refresh?" and "when is peak
*for me*?". Both answers now render in the viewer's own timezone, and
the dashboard got a proper visual pass (reference data-viz palette,
light + dark themes, system font, responsive layout).

- `/credits` grows instant-based fields so clients can localize:
  `weekly.resetsAt` (already existed) now joined by
  `fiveHour.clearsAt` (when the sliding window fully replenishes),
  `peak.changeAt` / `peak.windowStartAt` / `peak.windowEndAt`, and
  top-level `warnPct`. Internally `minutesUntilPeakChange()` is now
  derived from a shared `peakWindow()` helper (current-or-next window
  as absolute instants) — one source of truth for hints and snapshot.
- Dashboard weekly meter shows "resets Wed, 26 Aug, 21:17 · in 4d 3h"
  in local time; the 5h meter shows when the window clears if idle.
- Peak card: current/off-peak state with the next change as a local
  clock time, plus a Mon–Sun week strip placing each day's 14:00–18:00
  SGT peak block on your local 24h lane with a now-marker — computed
  from instants, so it stays correct across timezones, midnight-
  straddling windows, and your own DST changes.
- The in-conversation peak hint now appends the machine-local
  translation of the SGT window (e.g. `14:00-18:00 UTC+8 = 08:00-12:00
  on this machine`).

## 1.6.1 (success lines get the gloss too)

1.6.0 decorated every failure status but left the one line a healthy
router prints on every request bare: `upstream <- HTTP 200 from
glm-5`. Now it reads `upstream <- HTTP 200 (ok) from glm-5`, so
success and failure lines scan the same way and a bare `HTTP 200`
never appears in debug output.

- `httpStatusHint()` grows a `200: "ok"` entry — the only success
  status LLM upstreams actually return.
- The test harness gains a stdout tail (debugLog writes to stdout,
  warnings to stderr) and the hint test now runs with `DEBUG=1` to
  pin the `200 (ok)` success line (218 assertions).

## 1.6.0 (readable upstream error logs)

A bare `classifier HTTP 529` in the log tells you nothing at 2am —
you end up grepping what the status means before knowing whether to
wait it out, rotate a key, or fix a config path. (Debugging exactly
such a 401 while setting up a separate classifier key is what
prompted this.)

- **`httpStatusHint()`** maps the statuses upstreams actually return to
  a plain-language cause: 401 `auth failed — key invalid, expired, or
  wrong provider`, 403 `forbidden — key lacks access to this model`,
  404 `not found — wrong baseUrl or model name`, 429 `rate limited —
  quota or RPM exceeded`, 529 `overloaded — upstream at capacity`, and
  so on; unmapped 5xx fall back to `upstream error`.
- Wired into every failure log site — the classifier retry lines, the
  final throw (which the `triage failed (...)` warnings echo), ollama
  errors, and the `upstream <- HTTP ...` debug trace — so failures now
  read e.g. `triage failed (classifier HTTP 529 (overloaded — upstream
  at capacity)), falling back`.
- Success logs were initially left bare here — 1.6.1 adds the gloss.
- Test suite grows a stderr-tail capture helper and a test forcing
  mock 529/401 classifier replies to pin the hint text (217
  assertions, up from 213).

## 1.5.0 (classifier resilience + compact detection)

When Claude Code fires a turn, 3 concurrent requests hit the same GLM
key (real turn + 1–2 title-gen side-channels + classifier). The key's
per-key RPM/burst limit trips with HTTP 429, and the classifier's
original retry loop had no jitter, ignored `Retry-After`, didn't drain
error bodies (holding HTTP/2 stream slots), lacked single-flight and a
circuit breaker, and its catch block hardcoded `medium`. Result:
thundering-herd retry storms, classifier failures, and cost regression
(0.15 → 0.40) on recovery.

Fix: config-overridable knobs (all defaults safe, existing configs work
unchanged):

- **Exponential backoff with ±40% jitter** — eliminates lockstep retry
  storms; honors `Retry-After` header up to `backoffMaxMs`.
- **Deadline-bounded retry loop** (`deadlineMs=15000`, capped at 25% of
  upstream timeout) — per-attempt timeout reduced from 30s to 8s.
- **Error body drained** via `res.body?.cancel()` on `!res.ok` — releases
  HTTP/2 stream slots.
- **Circuit breaker** (closed → open after 3 failures, half-open probe
  after 60s) — prevents re-flooding an already-overloaded upstream.
- **Single-flight dedupe** (`classifyInFlight` map) — byte-identical
  in-flight prompts share one Promise (fixes title-gen duplicate calls).
- **Smarter fallback chain** — prior session complexity → heuristic
  (if enabled) → `medium` (last resort). Fixes the hardcode fallback.
- **Title-gen skip** (`titleGenSkip=on`) — regex matches `<session>…</session>`
  and `title` keyword, routes to `super_easy` without a classifier call.
- **Compact skip** (`compactSkip=on`) — regex matches `CRITICAL: Respond
  with TEXT ONLY`, routes to `medium` (or `hard` for >30 messages)
  without a classifier call. Fixes non-deterministic /compact routing.
- **Observability** — `/health` exposes breaker state, in-flight count,
  skip stats (`singleFlightHits`, `breakerSkips`, `titleGenSkipped`,
  `compactSkipped`). Startup logs all knobs.

New `test/run-tests.js` resilience suite (14 tests, filterable via `node
test/run-tests.js resilience`) proves each fix.

## 1.4.0 (security & robustness hardening)

Applied from an external engineering + security review:

- **Credit hints no longer break the prompt-cache prefix.** The 5-hour and
  peak-hour hints are appended to the session's *last* user message (the
  per-turn mutable tail) instead of the first, which carries the
  byte-frozen repo-map block — previously turn 2 rewrote the cache-stable
  prefix, so every later turn paid full input price for the map.
- **Passthrough is allowlisted.** Only known Anthropic non-chat endpoints
  forward to the upstream; other paths get a 404 and `..`/`\` traversal
  attempts a 400. The proxy can no longer be steered into attaching your
  API key to arbitrary upstream paths.
- **Timing-safe `routerToken` comparison** (`crypto.timingSafeEqual`).
- **Stronger session keys**: SHA-256, seeded with `metadata.user_id` when
  present, so two users typing the same first message on one machine no
  longer share budget/escalation/repo-map state.
- **Per-IP rate limiting** via the new `rateLimit` config (`rpm`,
  `burst`, `trustXff`) — off by default.
- **Genericized upstream errors**: clients get `router: upstream call
  failed` without the underlying `ECONNREFUSED host:port` detail; the
  verbose error stays in the server log.
- **Debug logs redact secrets** (`sk-ant-…`, `sk-…`, `ghp_…`, `AKIA…`,
  `password=`/`api_key=`/`token=` assignments, `Bearer` JWTs) and log
  request paths without query strings.
- **Classifier prompt-injection defense**: the triage prompt treats the
  user message as untrusted data, and classifier-returned assumptions are
  sanitized (paths, URLs, env vars, secrets, and tool invocations are
  dropped; capped at 200 chars and 4 items) before any clarification note
  is appended.
- **`credits-state.json` is written with mode `0600`**, matching the
  keystore.
- Smaller fixes: `structuredClone` instead of a JSON deep-clone round-trip,
  explicit symlink skip in the repo-map walk, `.unref()`'d abort timers,
  centralized eviction across all per-session maps (was a slow leak),
  tightened failure-escalation patterns (long legitimate "I cannot
  complete…" replies no longer burn a tier escalation), tightened the
  `super_hard` keyword heuristic ("what is a design system?" no longer
  routes to super_hard), keyword-mode clarity parsing tolerates trailing
  punctuation, and `.env` inline `# comments` are stripped.
- New `test/security-tests.js` regression suite (auth, passthrough,
  session-key isolation) wired into `npm test`.

## 1.3.0

- Budget enforcement: `budgetMax` / `budgetReject` give the logged cost
  weights teeth — breached sessions downgrade to the cheapest tier or get
  rejected.
- Auto-escalation: upstream failures and 5xx trigger one retry on the
  next-smarter tier (capped per session).
- GLM Coding Plan credit tracking: 5-hour sliding + weekly anchored
  windows, peak/off-peak 0.5× accounting, one-time hints, `GET /credits`,
  and crash-safe ledger persistence.
- Classifier optimizations: a keyword heuristic pre-filter and a
  classification cache, both configurable (`heuristic`,
  `classifyCacheTtlMs`) and off-capable for testing.
- One-time `/compact` hint after `compactHintTurns` user turns.
- Router shutdown no longer hangs on idle keep-alive sockets
  (`server.closeIdleConnections()`).

## Earlier (fixes applied before formal versioning)

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
suite (`node test/run-tests.js` — credits, repo-map lifecycle, JSON mode,
keyword mode, Ollama, fallbacks, env overrides, auth, and error paths;
plus `node test/extra-probes.js` for gzip passthrough and concurrency).
