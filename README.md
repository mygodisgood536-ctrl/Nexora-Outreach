# Nexora Outreach

AI-powered prospecting and outreach, on autopilot.

Implementation source of truth: `spec-reference/spec.txt` (extracted from
`Nexora_Outreach_Full_Vision_and_Cline_Implementation_Instructions.docx`).

> **Status: PARTIAL — not yet a complete product.**
> See [Implementation status](#implementation-status) for exactly what is built,
> verified, and still missing. This is an honest engineering report, not a
> claim of completion.

---

## Architecture

Zero runtime dependencies. Everything is built on the Node.js standard library:

| Concern | Choice |
|---|---|
| Runtime | Node.js >= 22.5 (developed on v24.18.0) |
| Persistence | `node:sqlite` (built-in, WAL, FK enforcement) |
| Crypto | `node:crypto` — scrypt KDF, AES-256-GCM |
| HTTP | `node:http` + a small router |
| AI runtime | The installed **OpenCode** CLI (central provider/model layer) |
| Email | OAuth 2.0 against Google and Microsoft Graph |
| Discovery | OpenStreetMap Overpass (keyless, permitted) |
| Tests | `node:test` |

```
src/
  config.js                 env loading, secret resolution, OpenCode binary detection
  db/                       24-table schema + connection/migrations
  core/                     crypto, errors, logger, normalize, timezone
  ai/
    opencode-adapter.js     real OpenCode CLI: catalog, execution, event parsing
    runtime.js              AIRuntime — the single interface business logic calls
    prompts.js              prompt construction + evidence-discipline guardrails
    tasks.js                AI operations with output validation
  email/
    provider.js             EmailProvider contract + EmailService (token lifecycle)
    google.js               Google OAuth + Gmail API
    microsoft.js            Microsoft OAuth + Graph
  discovery/
    overpass.js             OpenStreetMap Overpass discovery
  services/
    auth.js, sessions.js, rate-limit.js, audit.js
    missions.js             mission CRUD, windows, locations, lifecycle
    leads.js                lead persistence + cross-mission dedupe
    suppression.js          opt-out, bounce and complaint suppression
    email-store.js          encrypted mailbox token storage
  workers/
    queue.js                durable job queue: claim/lease, retry, recovery
```

### Central AI runtime (spec §7, §31)

Business logic never talks to a provider directly. It calls `AIRuntime`:

```js
const ai = new AIRuntime({ db });
await ai.catalog();                       // discovered LIVE from OpenCode
await ai.setSelection(userId, 'opencode/x'); // validated against the live catalog
await ai.completeJson(userId, 'qualify', { prompt, validate });
```

* The catalog comes from `opencode models` — there is **no hard-coded provider or
  model list** anywhere in this codebase.
* Execution uses `opencode run <prompt> --model <id> --format json`, parsing the
  real NDJSON event stream (`step_start`, `text`, `step_finish`).
* Provider credentials are never exposed to the frontend.
* Changing the selected model changes subsequent execution without a rebuild.

### Windows note

`opencode.cmd` (the npm shim) cannot be spawned directly on Windows (`EINVAL`).
The adapter resolves the real `opencode.exe` behind it and spawns that without a
shell, which also avoids `cmd.exe` quoting problems with multi-line prompts.

---

## Setup

```bash
cd nexora-outreach
npm run migrate      # create/verify the SQLite schema
npm test             # run the unit suite
```

Optional `.env` (see `.env.example`). Required in production:
`TOKEN_ENCRYPTION_KEY` (32 bytes hex) — encrypts email authorization tokens.

### Verifying the OpenCode integration

```bash
npm run probe:opencode
```
Reads `_probe_result.txt`. Confirms version, live model catalog, rejection of
models OpenCode does not offer, real text execution, structured JSON output, and
model switching.

---

## Implementation status

### Built and verified

| Area | Evidence |
|---|---|
| Schema: 24 tables, FKs, unique dedupe indexes | `npm run migrate` |
| scrypt hashing, AES-256-GCM + tamper detection | `test/unit/core.test.js` |
| Domain/email/name normalisation, dedupe keys | `test/unit/core.test.js` |
| Timezone windows incl. midnight wrap | `test/unit/core.test.js` |
| Job queue: claim, idempotency, retry, lease recovery, safe stop | `test/unit/queue.test.js` |
| Auth: signup, duplicate username, login, lockout, sessions | `test/unit/auth.test.js` |
| Missions, leads, suppression, email token storage | `test/unit/missions.test.js` |
| Discovery query construction, injection safety | `test/unit/discovery.test.js` |
| **Full pipeline discovery → send** | `test/e2e/pipeline.test.js` |
| **Retry, lease expiry, restart recovery, pause/stop** | `test/e2e/lifecycle.test.js` |
| **Suppression, limits, replies, follow-ups** | `test/e2e/policy.test.js` |
| **Window/timezone scheduling** | `test/e2e/scheduler.test.js` |

`npm test` → **108 passing** (71 unit + 37 end-to-end).

### The autonomous path that now runs

`Scheduler` (window + timezone) → `JobQueue` → `WorkerRuntime` → 8 handlers:

```
discovery → research → site_analysis → qualification → outreach → email
                                      ↘ mailbox_monitor → follow_up
```

Each stage reads persisted state from the previous one and writes what the next
needs. Every stage is retryable, idempotent, leased and recoverable.

### Still to build before the HTTP API and UI

* `src/app.js` — process entry point that starts the scheduler + worker loop.
* `src/http/*` — REST API and session middleware (§40 next steps).
* Dashboard and UI (§20–22, §36–37).

### Known issues and limitations

* Live structured-JSON AI execution was not confirmed end-to-end; plain
  execution is verified live (`value="PONG"`). The JSON validators themselves
  are exercised on every E2E run.
* Google/Microsoft OAuth needs real client credentials to verify the round
  trip. Everything around it (scopes, token refresh, encrypted storage,
  suppression, limits) is implemented and tested.
* Overpass rate limits aggressively; point `OVERPASS_URL` at a dedicated
  instance in production. Nominatim is unreachable from this machine, so
  Overpass resolves the search area itself.
* Overpass rejects User-Agents containing `localhost` or imitating a browser;
  `RESEARCH_USER_AGENT` is configurable.
* `npm test` runs both suites; on this machine the terminal kills processes past
  ~60 s, so `npm run test:unit` and `npm run test:e2e` may need running
  separately.