# Nexora Outreach

AI-powered prospecting and outreach, on autopilot.

Implementation source of truth: `spec-reference/spec.txt` (extracted from
`Nexora_Outreach_Full_Vision_and_Cline_Implementation_Instructions.docx`).

> An autonomous outreach platform: define a mission in plain language, and the
> system discovers real businesses, researches their public web presence,
> qualifies them against your bar, writes and (optionally) sends personalised
> outreach, monitors replies, schedules follow-ups, and honours opt-outs.
>
> The **OpenCode** integration is live: the central AI Runtime runs on OpenCode
> **Cloud** in production (one service-account key reaches OpenAI/Anthropic/Gemini
> model families), with a local-binary transport for development. The
> provider/model catalog is discovered from the OpenCode workspace, never
> hard-coded.

---

## Architecture

One runtime dependency (`pg`, for the production database). Everything else is
the Node.js standard library:

| Concern | Choice |
|---|---|
| Runtime | Node.js >= 22.5 (developed on v24.21.0) |
| Persistence (prod) | PostgreSQL — Neon, provisioned through Vercel |
| Persistence (dev/tests) | `node:sqlite` (built-in) — zero-install |
| Crypto | `node:crypto` — scrypt KDF, AES-256-GCM |
| HTTP | `node:http` + a small router; also a Vercel serverless handler |
| Frontend | A dependency-free single-page app (`public/`), deep-space theme |
| AI runtime | **OpenCode** — CLI transport (local), HTTP transport (`opencode serve`), or the OpenCode Cloud gateway (production) |
| Email | OAuth 2.0 against Google and Microsoft Graph |
| Discovery | OpenStreetMap Overpass (keyless, permitted) |
| Tests | `node:test` |

### Dual-database design

All services are asynchronous and talk to one `Db` facade. The driver is chosen
at startup:

```
DATABASE_URL set  → PostgresDriver  (production: Neon)
DATABASE_URL blank → SqliteDriver    (development and tests)
```

SQL stays written in a SQLite-flavoured dialect (`?` placeholders,
`datetime('now')`); `src/db/dialect.js` translates it for PostgreSQL. The
schema is versioned (`SCHEMA_VERSION`) and `migrate()` is idempotent, so a fresh
Neon branch is provisioned automatically on first boot.

### Layout

```
src/
  app.js                    process entry: migrate, serve, scheduler + worker loops
  config.js                 env loading, secret resolution, OpenCode/DB/cron config
  system.js                 composition root — the one object graph
  db/                       schema(.postgres).sql, dialect, drivers, migrate
  core/                     crypto, errors, logger, normalize, timezone
  ai/
    transport.js            CliTransport | HttpTransport | OpenCodeCloudTransport
    cloud-transport.js      OpenCode Cloud: config discovery + inference gateway
    runtime.js              AIRuntime — the single interface business logic calls
    prompts.js              prompt construction + evidence-discipline guardrails
    tasks.js                AI operations with output validation
  email/                    provider contract + Google/Microsoft OAuth
  discovery/overpass.js     OpenStreetMap Overpass discovery
  research/                 real HTML fetcher + website/presence analysis
  services/                 auth, sessions, missions, leads, suppression, …
  workers/                  queue, runtime, scheduler, 8 stage handlers
  http/
    server.js               request listener + static SPA serving
    router.js               default-auth, default-CSRF routing
    routes/{account,workspace,system}.js
public/                      the single-page application
api/index.js                 Vercel serverless entry (wraps the request listener)
vercel.json                  deploy config: static output, function, cron
```

### Central AI runtime (spec §7, §31)

Business logic never talks to a provider directly. It calls `AIRuntime`, which
sits on a transport:

```js
const ai = new AIRuntime({ db });
await ai.catalog();                          // discovered LIVE from OpenCode
await ai.setSelection(userId, 'opencode/x'); // validated against the live catalog
await ai.completeJson(userId, 'qualify', { prompt, validate });
```

* **OpenCode Cloud transport** (production) talks to the OpenCode Cloud gateway
  over HTTPS. It discovers the workspace provider/model catalog from
  `GET {OPENCODE_CONSOLE_URL}/api/v2/config` and runs each prompt on the gateway
  whose family the model declares (OpenAI-compatible chat completions, Anthropic
  messages, or Gemini `generateContent`). Selected automatically whenever
  `OPENCODE_API_KEY` is an `oc_sk_…` service-account key — the same key is the
  only secret needed.
* **CLI transport** spawns the local `opencode` binary and parses its real
  NDJSON event stream. **HTTP transport** speaks to a remote `opencode serve`
  instance (`/global/health`, `/config/providers`, `POST /session`,
  `POST /session/:id/message`). Chosen when `OPENCODE_BASE_URL` is set.
* The catalog is always discovered at runtime from OpenCode — **no hard-coded
  provider or model list**. The configured `OPENCODE_DEFAULT_MODEL` is only an
  initial preference, validated against the live catalog.
* Every worker stage that needs intelligence — research interpretation, website
  analysis, presence analysis, qualification, outreach generation and reply
  interpretation — calls `AITasks`, which calls `AIRuntime`, which calls the
  transport. Deterministic work (scheduling, queues, DB state, limits, sending,
  OAuth, suppression, retries, dedup, audit) stays outside the AI layer.
* Timeouts, bounded retries, and a shared error taxonomy (`AI_TIMEOUT`,
  retryable `AI_PROVIDER_ERROR`, permanent `UNAUTHENTICATED` /
  `AI_MODEL_UNAVAILABLE`) are applied uniformly. The service-account key is
  server-side only and is never exposed to the frontend or returned by
  diagnostics.

---

## The autonomous pipeline

```
Scheduler (window + timezone)
   → JobQueue (durable, leased, idempotent)
     → WorkerRuntime → 8 handlers:

discovery → research → site_analysis → qualification → outreach → email
                                       ↘ mailbox_monitor → follow_up
```

Each stage reads the previous stage's persisted state and writes what the next
needs. Every job is retryable, idempotent, leased, and recovered after a crash.
On Vercel (no long-lived process) the same pipeline is driven by a Cron hitting
`GET/POST /api/cron/tick`, which advances due missions and drains a bounded
number of jobs.

---

## The frontend

`public/` is a single-page app (hash-routed, no build step, no framework) that
covers the whole product surface: sign in / sign up / recover; the command
dashboard; mission creation with an optional "interpret with AI" step; mission
detail with lifecycle controls and activity; prospects with filters and lead
detail (website analysis, qualification, message history, suppression);
conversations with approve/reject; notifications; and a control panel for the
AI model, mailbox connections, automation pause, recovery code and suppressions.

The server serves it directly: `/` and deep links fall back to `index.html`;
`/styles.css`, `/app.js` and `/favicon.svg` are served with correct types;
unknown assets 404; `/health` stays JSON.

---

## Setup

```bash
npm install
npm test                 # unit + end-to-end suites
npm start                 # http://localhost:4317 (SQLite unless DATABASE_URL is set)
```

Configuration lives in `.env` (see `.env.example`). Nothing is required to run
locally — SQLite and the UI work out of the box. For production:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL DSN (production database) |
| `TOKEN_ENCRYPTION_KEY` | 32-byte hex; encrypts stored mailbox tokens |
| `PUBLIC_BASE_URL` | Public origin; used to build OAuth redirect URIs |
| `OPENCODE_API_KEY` | **OpenCode Cloud service-account key** (`oc_sk_…`) — the production AI runtime. Server-side secret. |
| `OPENCODE_CLOUD_URL` / `OPENCODE_CONSOLE_URL` | Optional gateway/discovery hosts (default `https://opencode.ai` / `https://console.opencode.ai`) |
| `OPENCODE_DEFAULT_MODEL` | Initial model preference (validated against the live OpenCode catalog) |
| `OPENCODE_BASE_URL` | Self-hosted `opencode serve` URL (alternative to Cloud; local/dev) |
| `CRON_SECRET` | Authenticates the `/api/cron/tick` serverless driver |
| `WEBHOOK_SECRET` | Authenticates provider bounce/complaint callbacks |

### Deploying to Vercel

The project is deploy-ready: `vercel.json` sets `public/` as the static output,
routes `/api/*` to the `api/index.js` serverless function, rewrites unknown
paths to the SPA shell, and registers a 5-minute Cron against `/api/cron/tick`.

1. Create a Neon database and set `DATABASE_URL` on the Vercel project.
2. Set `CRON_SECRET`, `TOKEN_ENCRYPTION_KEY` and `PUBLIC_BASE_URL`.
3. Deploy. The first request migrates the schema automatically.
4. Set `OPENCODE_API_KEY` to the OpenCode Cloud service-account key (`oc_sk_…`)
   to enable the AI stages. (A self-hosted `OPENCODE_BASE_URL` also works.)

> Vercel Cron granularity below once-per-day requires a paid plan. On Hobby,
> point any external scheduler at `/api/cron/tick` with the bearer secret.

### Email OAuth (Google / Microsoft)

1. Create an OAuth client; the redirect URI must be
   `${PUBLIC_BASE_URL}/api/email/<provider>/callback`.
2. Set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` or
   `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET` (+ `MICROSOFT_TENANT`).
3. In **Control → Mailbox connections**, press *Connect*.

No mailbox password is ever requested or stored; only OAuth tokens, encrypted
at rest, are kept.

---

## Testing

```bash
npm test          # everything
npm run test:unit # unit only
npm run test:e2e  # end-to-end only
```

The suite (180 tests) covers crypto, the job queue, auth/lockout, missions,
leads, discovery query construction, the full pipeline, retries/leases/restart
recovery, suppression and limits, window/timezone scheduling, the HTTP API
surface (auth, CSRF, ownership, 404/405, filters), platform features
(notifications, activity, dashboard, recovery), the OpenCode transport, mission
interpretation and delivery-event ingestion, and the serverless cron driver +
static serving.

---

## Security posture

* scrypt password/answer hashing; AES-256-GCM token encryption with tamper
  detection.
* Sessions are server-side rows; the cookie is opaque. CSRF is enforced by
  default on every non-GET route via an HMAC of the session id.
* Every workspace route is ownership-checked; cross-user access 404s.
* Rate limits on auth and AI; progressive login lockout.
* Constant-time comparisons for CSRF tokens and webhook/cron secrets.
* The server never leaks internals; unexpected errors become a generic 500.
* Suppression (opt-out, hard bounce, complaint) is absolute and checked before
  every send.

## Known limitations

* OpenCode Cloud is wired and **verified live**: a real model request runs
  through `AIRuntime` end to end (see `evidence/FINAL-REPORT.md`). Models the
  workspace has not enabled return a clear, non-retried `AI_MODEL_UNAVAILABLE`;
  switch model in Settings.
* Google/Microsoft OAuth round-trips require real client credentials; the code
  around them (scopes, refresh, encrypted storage) is implemented and tested.
* Overpass rate-limits aggressively and rejects browser-like User-Agents;
  point `OVERPASS_URL` at a dedicated instance in production.
* The frontend is verified by static-serving tests and a live server smoke run,
  not by browser automation.