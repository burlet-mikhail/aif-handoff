# Refactor: Codex login broker → device-auth flow

**Created:** 2026-04-27
**Branch:** _not created_ (current: `ci/test-pr-2026-04-27`; create `feature/codex-device-auth` from `main` before `/aif-implement`)
**Type:** Refactor — replaces auth-URL+callback OAuth flow with `codex login --device-auth`

## Settings

- **Testing:** yes — rewrite affected unit + integration tests
- **Logging:** verbose — DEBUG chunk + parse + child exit; INFO on session start/end; redact one-time code in all logs (mask all but last 2 chars)
- **Docs:** yes — mandatory checkpoint at completion (providers.md, README.md, configuration.md)
- **Roadmap linkage:** none

## Roadmap Linkage

Milestone: "none"
Rationale: Skipped — internal refactor, no roadmap milestone for this cleanup.

## Context

`codex login --device-auth` (verified on codex-cli **v0.124.0**) prints a fixed verification URL `https://auth.openai.com/codex/device` and a one-time code (format `[A-Z0-9]{4}-[A-Z0-9]{4,}`, e.g. `5PZO-GPZLR`). The CLI then waits while the user enters that code in their browser. When the user completes the flow, the CLI exits 0 and writes `~/.codex/auth.json`. **No loopback callback is involved.**

This makes the entire callback machinery in `loginBroker.ts` obsolete:
- No localhost:1455 callback to bridge.
- No SSRF guard, no state matching, no callback URL paste.
- No api `/auth/codex/login/callback` proxy route.
- `AIF_CODEX_LOGIN_LOOPBACK_PORT` env var is dead.

### Captured stdout (real CLI, ANSI-stripped)

```
Welcome to Codex [v0.124.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   5PZO-GPZLR

Device codes are a common phishing target. Never share this code.
```

### Parsing strategy

1. Strip ANSI escape sequences: regex `\x1B\[[0-9;]*[A-Za-z]` → `""`.
2. Match URL: literal `https://auth.openai.com/codex/device` (fixed, no query params).
3. Match code: `\b[A-Z0-9]{4}-[A-Z0-9]{4,}\b` _after_ the URL match. Both must be present to resolve the parse.

## Out of scope

- `AIF_ENABLE_CODEX_LOGIN_PROXY` gate semantics — unchanged.
- Adapter-level auth changes (`packages/runtime/src/adapters/codex/`).
- Polling cadence tuning beyond what the new shape needs.
- Backwards compatibility for the old paste-callback UI — deleted, not deprecated.

## Tasks

### Phase 1 — Backend broker

- [x] **Task 1:** Refactor `packages/agent/src/codex/loginBroker.ts`.
  - Spawn args: `["login", "--device-auth"]`.
  - Replace `extractAuthUrlFromStdout` + `extractStateFromAuthUrl` with `extractDeviceAuth(buffered: string): { verificationUrl; userCode } | null` (ANSI strip + fixed URL + code regex).
  - Drop `validateCallbackUrl`, `redactCallbackUrl`, `CallbackValidationResult`, `callbackBodySchema`, `/codex/login/callback` handler, `loopbackHost`/`loopbackPort` options + defaults.
  - `LoginSession`: `{ id, child, verificationUrl, userCode, startedAt, timeoutHandle }`.
  - `/codex/login/status` + `/codex/login/start` responses use `{ verificationUrl, userCode }`.
  - Wait for child exit naturally; keep 5-min session timeout + cancel handler.
  - **Logging:** DEBUG chunk first 200 chars; DEBUG `"device auth parsed"` with `userCodeMasked` (only last 2 chars visible); INFO session start with sessionId; INFO child exit with `code`/`signal`.
  - File no longer references SSRF / callback / loopback / state.

- [x] **Task 2:** Update `packages/agent/src/index.ts` (depends on Task 1).
  - Drop `loopbackPort: env.AIF_CODEX_LOGIN_LOOPBACK_PORT` from `startLoginBroker(...)` call (~line 91).

- [x] **Task 3:** Rewrite broker tests (depends on Task 1).
  - `packages/agent/src/codex/__tests__/loginBroker.url.test.ts`: replace URL/state/callback tests with `extractDeviceAuth` tests (happy path with ANSI fixture, missing code, missing URL, malformed code, ANSI strip).
  - `packages/agent/src/codex/__tests__/loginBroker.integration.test.ts`: replace callback POST flow with device-flow happy-path (start → status active → simulated child `exit(0)` → status inactive) + cancel test.

**Commit checkpoint:** `refactor(codex-login): switch broker to --device-auth flow`

### Phase 2 — API surface

- [x] **Task 4:** Drop `/login/callback` route + `codexCallbackSchema`.
  - `packages/api/src/routes/codexAuth.ts`: remove the `/login/callback` block (lines 65–73), drop `redactUrl` if no longer used, drop `codexCallbackSchema` import. `/capabilities` returns `{ loginProxyEnabled }` only.
  - `packages/api/src/schemas.ts`: delete `codexCallbackSchema` export (~line 263).
  - `packages/api/src/index.ts` (~line 91): placeholder `/capabilities` response when broker disabled — drop `loopbackPort` field.

- [x] **Task 5:** Update API codexAuth tests (depends on Task 4).
  - `packages/api/src/__tests__/codexAuth.routes.test.ts`: drop callback test cases; update capabilities/start/status assertions to new shapes.

**Commit checkpoint:** `refactor(api): drop codex login callback route + loopback fields`

### Phase 3 — Env cleanup

- [x] **Task 6:** Drop `AIF_CODEX_LOGIN_LOOPBACK_PORT` (depends on Task 4).
  - `packages/shared/src/env.ts:138`: remove the schema entry.
  - `packages/agent/src/__tests__/hooks.test.ts:73`: drop the loopback fixture line.
  - Repo-wide grep for `AIF_CODEX_LOGIN_LOOPBACK` in `*.ts`/`*.tsx` must return zero matches after change.

### Phase 4 — Web UI

- [x] **Task 7:** Update `packages/web/src/lib/api.ts` + `packages/web/src/hooks/useCodexLogin.ts`.
  - `getCodexLoginCapabilities`: `Promise<{ loginProxyEnabled: boolean }>`.
  - `getCodexLoginStatus`/`startCodexLogin` return `{ verificationUrl, userCode, sessionId, startedAt, ...active flag }`.
  - Remove `submitCodexCallback` method + `useSubmitCodexCallback` hook export.

- [x] **Task 8:** Rewrite `packages/web/src/components/settings/CodexLoginCard.tsx` (depends on Task 7).
  - Drop paste textarea + Submit-callback flow.
  - Wizard steps: `idle` → `awaiting_completion` (polling `useCodexLoginStatus`) → `success` | `error`.
  - Display: large monospace `userCode` + Copy-code button + "Open verification page" button (`window.open(verificationUrl)`) + Spinner + Cancel.
  - Detect completion: `statusQuery.data.active === false` while in `awaiting_completion` → flip to `success`. Keep "Restart agent" hint.
  - Adopt in-flight session on mount; adopt 409 body on Start.
  - Reuse only existing UI primitives (Card, Button, AlertBox, Spinner). No box-shadow / backdrop-filter / blur per CLAUDE.md UI rules.

**Commit checkpoint:** `refactor(web): replace codex login paste UI with device-flow card`

### Phase 5 — Docs

- [x] **Task 9:** Update `docs/providers.md` broker section (~lines 255–310).
  - Rewrite "Codex OAuth login (in-Docker broker)": new device-flow narrative, new ASCII diagram (no callback step).
  - Endpoint table: drop `/auth/codex/login/callback` row; update start/status payload columns to mention `verificationUrl` + `userCode`.
  - Env table: drop `AIF_CODEX_LOGIN_LOOPBACK_PORT` row.

- [x] **Task 10:** Update `README.md` + `docs/configuration.md`. Also removed dead `.docker/aif-codex-callback.sh` helper + Dockerfile COPY/RUN lines (callback no longer exists).
  - `README.md` lines 85–97: rewrite codex login subsection (code + URL flow, no loopback story).
  - `docs/configuration.md`: keep `AIF_ENABLE_CODEX_LOGIN_PROXY` row; remove `AIF_CODEX_LOGIN_LOOPBACK_PORT` row.
  - After change: grep `1455` + `loopback` in these files — zero matches expected.

**Commit checkpoint:** `docs(codex-login): rewrite broker section for device-flow`

### Phase 6 — Validate

- [x] **Task 11:** `npm run ai:validate` — lint + build + tests + format + coverage. Fix all warnings. Also deleted obsolete `packages/api/src/__tests__/codexAuth.validation.test.ts` (referenced removed `codexCallbackSchema`).

## Commit Plan

| Step | Tasks | Suggested commit message                                            |
| ---- | ----- | ------------------------------------------------------------------- |
| 1    | 1–3   | `refactor(codex-login): switch broker to --device-auth flow`        |
| 2    | 4–6   | `refactor(api): drop codex login callback route + loopback fields`  |
| 3    | 7–8   | `refactor(web): replace codex login paste UI with device-flow card` |
| 4    | 9–10  | `docs(codex-login): rewrite broker section for device-flow`         |
| 5    | 11    | _no commit — validation gate_                                       |

## Acceptance

- `npm run ai:validate` clean.
- Repo grep returns zero matches for: `loopbackPort`, `loopbackHost`, `validateCallbackUrl`, `extractAuthUrlFromStdout`, `extractStateFromAuthUrl`, `submitCodexCallback`, `useSubmitCodexCallback`, `codexCallbackSchema`, `AIF_CODEX_LOGIN_LOOPBACK` (in `*.ts`/`*.tsx`).
- `/auth/codex/login/callback` returns 404 (route removed, no special handling).
- All four package test suites pass; agent + api coverage ≥ 70%.

### Manual smoke (post-merge)

1. `docker compose up -d agent api web`.
2. Settings → Codex runtime profile → Start Codex login.
3. Card shows large one-time code + verification URL.
4. Open URL in host browser → enter code → complete sign-in.
5. Card flips to success.
6. `docker compose exec agent codex login status` → authenticated.
7. `docker compose restart agent` to pick up new credentials.

## Notes for /aif-implement

- Branch creation deferred — current branch `ci/test-pr-2026-04-27` is unrelated PR test work. Before implementing, run:
  ```
  git checkout main
  git pull origin main
  git checkout -b feature/codex-device-auth
  ```
  (each as a separate Bash call per CLAUDE.md "no `&&` chaining" rule).
- Per CLAUDE.md memory: no Co-Authored-By trailer; no push without user approval; fix all lint warnings in scope.
