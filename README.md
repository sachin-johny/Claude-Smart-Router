# claude-smart-router

A local proxy for Claude Code that classifies each request and routes it to
the right backend — GLM, Claude, Ollama, or anything else that speaks the
Anthropic Messages API — instead of you manually switching models.

Zero npm dependencies — Node.js 18+ only (uses global `fetch`).

## Features

- **5-tier complexity routing**: `super_easy → easy → medium → hard → super_hard`,
  each mapped to whatever backend/model you configure.
- **Context inheritance**: short follow-ups ("yes", "try now?") inherit the
  complexity of the ongoing task instead of being misclassified as trivial.
- **Tool-aware floor**: requests with tool definitions route no lower than
  `tools.minComplexity` (default `medium`).
- **Auto-clarification (log-only)**: ambiguous prompts produce a list of
  assumptions shown to you in the terminal/dashboard — never forwarded to
  the model.
- **Budget enforcement**: `budgetMax` caps a session's cost-weight spend;
  breached sessions are downgraded to the cheapest tier (or rejected with
  `budgetReject: true`).
- **Auto-escalation**: on upstream failure or 5xx, the request is retried
  once on the next-smarter tier.
- **GLM Coding Plan credit tracking**: real 5-hour and weekly plan-credit
  accounting from actual usage, peak/off-peak rates, and an optional overlay
  that polls your Z.ai account directly.
- **Repo map**: a compact file-tree + exports summary injected per session,
  kept inside the prompt-cached prefix.
- **Dashboard**: self-contained HTML at `/dashboard` with live routing,
  credits, and log views.
- **Flexible keys**: Ollama as a free local classifier/backend, Claude Code
  OAuth tokens (`sk-ant-oat...`), and a customizable classifier prompt via
  `ROUTES.md`.

## Setup

```bash
npm install -g claude-smart-router
claude-smart-router key set route        # paste your GLM key (input hidden)
claude-smart-router key set classifier   # same key if classifier is GLM
claude-smart-router
```

That's it — with keys in the keystore and no `config.json`, the router
starts on the bundled defaults (GLM tiers, port 8787). Keys are stored in
`~/.claude-smart-router/keys.json`, outside every project directory.
`key list` shows them masked, `key remove <name>` deletes one,
`key show router` reveals the router token. Get a GLM key from your
z.ai account.

From a checkout, the same flow works with `node router.js`.

### Wire into Claude Code

Claude Code reads `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` at startup.
Edit `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8787",
    "ANTHROPIC_AUTH_TOKEN": "<router token>"
  }
}
```

The router checks this token, then injects the real per-backend keys
upstream. The token is printed on first start, or run
`claude-smart-router key show router`. **Fully restart VS Code** after
editing this file.

To uninstall: `npm uninstall -g claude-smart-router` — then manually undo
the `settings.json` edit and delete `~/.claude-smart-router/` if you want
a full cleanup.

## Configuration

`config.json` is only needed for defaults you want to change — copy
[config.example.json](config.example.json) to your working directory and
edit. The essentials:

- `routes.super_easy` … `routes.super_hard` — one backend per tier.
- `classifier` — the cheap model that triages every request. Point it at
  Ollama (`baseUrl: http://localhost:11434`) for free local triage.
- `tools.minComplexity` — routing floor when tools are present.
- `budgetMax` / `budgetReject` — session spend cap (see Features).
- `repoMap` — per-session project overview (see below).
- `credits` — GLM plan tracking (see below).
- `rateLimit` — optional per-IP limit, e.g. `{ "rpm": 60 }`. Enable
  together with `routerToken` when binding beyond loopback.

Everything else — timeouts, retry/backoff, circuit breaker, cache TTLs,
dashboard options — is documented inline in
[config.example.json](config.example.json) with safe defaults.

### Keys and files

- **Key resolution** (later overrides earlier): `config.json` → `.env` →
  keystore → environment variables. Real env vars always win. In `.env`
  (copy [.env.example](.env.example)): `ROUTE_API_KEY`,
  `CLASSIFIER_API_KEY`, `ROUTE_<TIER>_API_KEY`, `ROUTER_TOKEN`.
- **File resolution**: `ROUTER_CONFIG` / `ROUTER_ENV_PATH` / `ROUTES_PATH`
  env vars → `~/.claude-smart-router/` → next to `router.js`. The current
  working directory is deliberately **not** searched — a cloned repo can't
  ship a `config.json` that redirects your keys. Opt in with
  `ROUTER_ALLOW_CWD_CONFIG=1` only for trusted directories.
- Invalid configs fail at startup with a list of exactly what's wrong.

### Custom classifier prompt (ROUTES.md)

If `ROUTES.md` exists next to `router.js` with a `{MESSAGE}` placeholder,
the router uses it instead of the built-in prompt. This keyword mode skips
auto-clarification; delete the file to get it back.

## HTTP endpoints

| Endpoint | What it does |
| --- | --- |
| `POST /v1/messages` | the proxy itself (what Claude Code calls) |
| `GET /health` | liveness: uptime, sessions, budget, credits, breaker state |
| `GET /credits` | live GLM plan usage: 5h/weekly totals, resets, peak state |
| `POST /credits/refresh` | force an immediate Z.ai account poll |
| `GET /map` | inspect the current repo map |
| `POST /map/refresh` | rebuild the repo map cache |
| `GET /logs` | tail of router console output (supports `?after=<seq>`) |
| `GET /dashboard` | self-contained HTML dashboard |
| `GET /keys` | masked keystore view — never returns plaintext |

All endpoints require the router token (except with `allowNoAuth: true`,
refused on non-loopback binds). The dashboard URL is logged on startup;
set `"openDashboardOnStart": true` to auto-launch a browser.

## Repo map

The router injects a compact file-tree + exports summary into a session's
first user message, so the model knows the project without you
`@`-mentioning files. The map is frozen per session and reuses the same
bytes every turn, so after the first write it sits in the prompt-cached
prefix (~10% of base input cost). After several turns it auto-compacts to
a one-liner.

**File mode**: set `writeToFile` (e.g. `.claude/repo-map.md`) and the
router maintains a generated map file in your project *instead of*
injecting into prompts - the file tree plus uncommitted changes, recent
commits, and recently modified files, kept current by a change watcher
(never overwrites files it didn't generate; target must be a `.md` inside
the project root). The model reads it on demand: add a line like
`Before searching for files, read .claude/repo-map.md` to your CLAUDE.md,
or regenerate once from a hook/CI with `claude-smart-router map`. Works
with `repoMap.enabled: false`; opt back into prompt injection with
`inject: true` (the map is then paid for twice).

```json
"repoMap": {
  "enabled": true,
  "maxTokens": 2000,
  "minComplexity": "medium",
  "pinnedFiles": [],
  "writeToFile": ".claude/repo-map.md"
}
```

`GET /map` shows the current map; `POST /map/refresh` forces a rebuild.

## Credit tracking (GLM Coding Plan)

Tracks real plan credits from the usage object on every response — never
estimated — against the plan's two windows:

- **5-hour window**: sliding ledger; credits replenish 5h after spend.
- **Weekly window**: fixed reset — set `weeklyResetAnchor` to your reset
  time for exact countdowns.
- **Peak hours** (Mon–Fri 14:00–18:00 UTC+8) bill at 1×, everything else
  at 0.5×.
- Crossing `warnPct` (default 80%) logs a one-time notice; the router
  never downgrades or inserts anything into the conversation.
- Set `credits.zaiAccountUsage: true` to also poll Z.ai's account usage
  directly, closing the blind spot for traffic that bypasses the proxy.

State persists to `credits-state.json`; `GET /credits` returns the full
snapshot. The dashboard renders everything in your local timezone.

## Security model

- **Auth is mandatory** — router token on every request, compared in
  constant time. Upstream keys are only ever sent to https hosts on the
  `allowedUpstreamHosts` allowlist.
- **Browser attacks blocked** — DNS-rebinding `Host` headers, cross-origin
  requests, and non-JSON bodies are rejected; the dashboard uses a
  nonce-based CSP.
- **Keys never leak** — logs are redacted; `/keys` returns masked values
  only; keystore perms are `0700`/`0600` where POSIX modes apply.
- **The prompt is never modified** except the optional repo map.
- Non-`/v1/messages` paths pass through only for an allowlisted set of
  Anthropic endpoints; anything else gets a 404.

## Limitations

- Session identity is approximated (system prompt + first message hash);
  identical sessions from the same user share routing state.
- Repo-map caching assumes the upstream honors prompt caching — lower
  `repoMap.maxTokens` if it doesn't.
- Classification sees your latest message plus a short context summary,
  not the full conversation.
- Single process; fine for a personal proxy's load.

## Docs

- [CHANGELOG.md](CHANGELOG.md) — full version history
- [config.example.json](config.example.json) — every option, with defaults

## License

MIT — see [LICENSE](./LICENSE).
