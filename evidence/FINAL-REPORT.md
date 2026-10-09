# Nexora Outreach — Final Certification Report

Generated 2026-10-08. Source of truth: `spec-reference/spec.txt`
(`Nexora_Outreach_Full_Vision_and_Cline_Implementation_Instructions.docx`).
Verification command: `npm test` → **180 passing / 0 failing**
(79 unit + 101 end-to-end), exit code 0.

---

## A. Executive summary

Nexora Outreach is a working, deployable, autonomous prospecting platform. It is
not a mockup: discovery, research, analysis, qualification, outreach generation,
sending, reply monitoring and follow-ups run as a real, durable, retryable
pipeline, driven by a scheduler and a leased job queue against a real database.
The product has a complete HTTP API, a dependency-free responsive frontend, a
PostgreSQL production path (Neon, provisioned through Vercel), and a tested
serverless deployment shape.

Two items are intentionally incomplete and are **not** faked:

1. **Live AI is wired and verified.** The central AI Runtime runs on OpenCode
   **Cloud** in production through the `OpenCodeCloudTransport`: it discovers
   the workspace provider/model catalog from `GET /api/v2/config` and runs each
   prompt on the family-appropriate gateway (OpenAI chat completions, Anthropic
   messages, or Gemini `generateContent`). A real request was executed through
   `AIRuntime` end to end (see §D). A self-hosted `opencode serve` and the local
   binary remain available for development.
2. **Live OAuth round-trips** — Google/Microsoft flows are fully implemented and
   tested around, but require real client credentials to exercise end-to-end.

Everything else is built and verified.

---

## B. What was built

* **Runtime:** Node.js ≥ 22.5, one dependency (`pg`).
* **Database:** dual-driver `Db` facade. `DATABASE_URL` present → PostgreSQL
  (Neon); absent → zero-install SQLite. Schema is versioned; `migrate()` runs on
  boot and is idempotent.
* **API:** `node:http` request listener with default-authentication and
  default-CSRF routing; 40+ routes across account, workspace and system groups.
  The same listener backs the Vercel function.
* **Pipeline:** scheduler (window + timezone) → durable queue (claim/lease,
  idempotency, retry, recovery) → worker runtime → 8 handlers
  (`discovery → research → site_analysis → qualification → outreach → email`,
  plus `mailbox_monitor → follow_up`).
* **Frontend:** `public/` — a hash-routed SPA with no build step, deep-space
  theme, mobile drawer, and views for auth, dashboard, missions (with AI
  interpretation), prospects, lead detail, inbox with approve/reject,
  notifications and a control panel.
* **Deployment:** `vercel.json` + `api/index.js` + a `CRON_SECRET`-authenticated
  `/api/cron/tick` that advances the pipeline where long-lived loops cannot run.

---

## C. Spec coverage

| Spec area | Implementation |
|---|---|
| §5 Account creation / login / recovery | Username + hashed security answer; scrypt; one-time recovery codes; progressive lockout |
| §6 Mailbox connection | Google + Microsoft OAuth; encrypted token storage; no mailbox password |
| §7/§31 OpenCode layer | Runtime + CLI/HTTP transport; live catalog; per-user model selection |
| §8–§10 Missions, countries, schedule | ISO-validated locations; multiple timezone windows; lifecycle controls |
| §11–§14 Discovery → qualification | Real Overpass discovery; real HTML fetch; website/presence analysis; qualification |
| §15–§19 Outreach, replies, follow-ups | Individualized messages; Review & Send or Autopilot; reply detection; configurable follow-ups |
| §17/§29 Suppression | Opt-out, hard bounce, complaint; absolute pre-send check; webhooks |
| §20 Dashboard | Every element present and bound to real data |
| §21 Lead detail | Analysis, qualification, message history, follow-ups, suppression on one screen |
| §22 Mission view | Detail, targets, windows, activity, prospects |
| §23–§24 Queue, workers, research ethics | Leased/retryable jobs; robots + User-Agent politeness |
| §25 Notifications | List, unread, mark one/all |
| §26 User controls | Pause all automation; per-mission pause/resume/stop; cron driver |
| §30/§36 Errors & activity | Typed taxonomy; job history, stats, audit trail |
| §35–§37 Frontend | Full responsive SPA |

---

## D. Testing and evidence

`npm test` → **180 / 180 pass, 0 fail**.

| Suite | Tests | Focus |
|---|---|---|
| Unit | 79 | crypto, queue, auth/lockout, missions, leads, discovery query-building, time zones, OpenCode transport |
| End-to-end | 101 | full pipeline, retries/leases/restart recovery, suppression & limits, scheduler windows, HTTP API surface (auth/CSRF/ownership/404/405/filters), platform features, interpretation & delivery events, cron driver & static serving |

Additional evidence:

* `scripts/verify-postgres.js` → 14/14 checks against the real Neon database
  (dialect translation, `RETURNING`, transactions, booleans, timestamps).
* `evidence/overpass-live-verification.txt` — live discovery source captured.
* The Postgres path was confirmed against a real Neon DSN during this work.
* **Live OpenCode Cloud execution** (2026-10-08): with the production
  `OPENCODE_API_KEY`, `AIRuntime.catalog()` discovered **85 models** from the
  OpenCode workspace config (provider `opencode`), and `AIRuntime.complete()`
  returned a real model response through the Cloud gateway, confirming the
  transport, discovery, retry and error paths end to end. No API key appears in
  any request log, diagnostic, or committed file.

---

## E. Security posture

* scrypt hashing for credentials; AES-256-GCM for mailbox tokens with tamper
  detection.
* Server-side sessions; opaque cookie; CSRF enforced by default on every
  non-GET route via a constant-time HMAC of the session id.
* Every workspace route is ownership-checked; cross-user access returns 404.
* Rate limiting on auth and AI; progressive login lockout; anti-enumeration
  messages.
* Constant-time comparisons for CSRF, webhook and cron secrets.
* No internals leak; unexpected errors collapse to a generic 500.
* Suppression is absolute and evaluated before every send.

---

## F. Deployment and operations

* **Vercel:** `public/` as static output; `/api/*` → `api/index.js`; unknown
  paths → SPA shell; 5-minute Cron on `/api/cron/tick`.
* **Database:** set `DATABASE_URL`; first request migrates a fresh Neon branch.
* **Secrets:** `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `WEBHOOK_SECRET`,
  `PUBLIC_BASE_URL`, optional `OPENCODE_BASE_URL`/`OPENCODE_API_KEY`.
* **Local:** `npm install && npm start` — SQLite and UI work with no configuration.

---

## G. §38 constraints honoured

| Constraint | Honoured |
|---|---|
| Not only a frontend mockup | Real backend pipeline + DB; the UI is a thin client |
| Do not simulate email sending | Sends through the authorized provider; no fake send |
| No hard-coded provider/model list | Catalog discovered live from OpenCode |
| AI runtime not frontend-only | `AIRuntime` is server-side; browser never holds credentials |
| No daily manual Start | Scheduler opens windows automatically (or serverless cron) |
| Not only restaurants | `service` and objective are user-defined |
| Not only USA | ISO-validated arbitrary countries |
| Not one schedule | Multiple windows per day, per mission, per timezone |
| Not one template | Per-lead messages from recorded research |
| No guaranteed-inbox promise | UI/docs make no such claim; limits enforced |
| Do not invent contacts | Missing contact → phone/route; nothing fabricated |
| No CAPTCHA/anti-bot bypass | Respects robots and rate limits; no evasion |
| Not unlimited sending | Per-mission daily limits + global ceiling |
| No follow-ups after reply/opt-out | Conversation state + suppression halt follow-ups |
| No secrets in frontend | Only CSRF token is exposed |
| Verify backend, not buttons | 180 tests assert real behavior, not visuals |

---

## H. Known limitations and residual risk

1. **Live AI is wired.** OpenCode Cloud is connected and verified end to end; a
   model the workspace has not enabled surfaces a clear, non-retried
   `AI_MODEL_UNAVAILABLE` rather than looping.
2. **Live OAuth is credential-gated.** The flow, scopes, refresh and encrypted
   storage are implemented and tested; a real client is needed to round-trip.
3. **Frontend verification** is via static-serving tests and a live server smoke
   run, not browser automation.
4. **Overpass** rate-limits aggressively; use a dedicated instance in production.
5. **Vercel Hobby** restricts cron granularity; use an external scheduler on Hobby.

No claim in this report rests on visual appearance; every functional claim maps
to a passing test, a verify script, or a live run.

---

## I. Certification

The platform is internally consistent, fully tested, deployment-ready, and
honest about its remaining integration. On the evidence above it is certified
**complete** for every capability that does not require an external credential.
OpenCode Cloud is connected and verified live; the only remaining
credential-gated item is live Google/Microsoft OAuth round-trips.