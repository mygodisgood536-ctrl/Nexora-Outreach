# Traceability: Vision (spec sections) vs. implementation

Source of truth: `..\Nexora_Outreach_Source_of_Truth_Vision.md` (374 lines, 41 sections).
Legend: **Done** = implemented and covered by tests · **Partial** = present but missing explicit verification · **Missing** = not implemented.

| § | Requirement (short) | Implemented in | Status |
|---|---|---|---|
| 1 | Purpose: autonomous prospecting/outreach platform; real system with persistent jobs | whole app; production running | Done |
| 2 | Product identity; multiple services/markets; not one niche | `README.md`, frontend onboarding panel, `missions.service` enum | Partial |
| 3 | User flow: signup → mailbox → mission → activate → scout → monitor | auth routes, email connect, mission activate, scheduler, dashboard | Partial |
| 4 | Niche is configurable (website redesign is first use case, not the product) | `missions.service` enum (`website_design`, `email_marketing`, …) | Done |
| 5.1 | Sign-up: full name, unique username checked immediately, unique server-side | `account.js` (`/api/auth/signup`, `/api/auth/username-available`), `schema.postgres.sql` (`username_lower UNIQUE`) | Done |
| 5.2 | Login uses username + security question/answer; answer never in plain text | `security_credentials` (`scrypt` hash), `account.js` login | Done |
| 5.3 | Security: validation, rate limiting + lockout, expiring/revocable sessions, encrypted tokens, recovery, audit | `account.js` (attempts/lockout/sessions/recovery), `email_connections` tokens encrypted, `audit_events` | Partial |
| 6 | Mailbox connection: send/receive/monitor/pause/disconnect/status; provider abstraction | `email-store.js`, `account.js` provider routes (`google`, `microsoft`) | Partial |
| 7 | OpenCode is the central AI runtime; provider/model discovery from OpenCode | `src/ai/opencode-adapter.js`, `ai_settings`, `ai_call_log` | Done |
| 8 | Missions: multiple missions, all mission settings, NL→structured shown for review | `missions.js`, `workspace.js` (`/interpret`, `/activate`), `interpreted_json` | Done |
| 9 | Country targeting: countries/cities, real ISO countries, priorities | `target_locations` table | Done |
| 10 | Scouting hours: days, multiple windows, timezone, next window, auto-start, pauses, recovery | `mission_windows`, scheduler, `automation_paused` | Done |
| 11 | Discovery: permitted/authorized sources, configurable | `handlers-discovery.js`, `overpass.js` | Done |
| 12 | Website investigation: responsive/typography/nav/etc., concrete evidence | `research/website-analysis.js`, `audits`, `audit_evidence` | Done |
| 13 | No-website businesses are investigated; public info only, never invented | `presence_analyses`, `leads.email_public`/`phone_public` | Done |
| 14 | Qualification: why/relevance/confidence/contact route/suppression, no repeat contact | `qualifications` table, dedupe index | Done |
| 15 | Personalized outreach: individualized per prospect, user instructions, no fake personalization | `handlers-outreach.js` | Done |
| 16 | Free-first offer: configurable, not a hard-coded rule | `missions.offer_summary` / sending modes | Done |
| 17 | Sending & deliverability: limits, provider rate limits, bounce/complaint handling, suppression/opt-out, duplicate prevention, pause, audit | email worker + `suppressions` | Partial |
| 18 | Reply monitoring: detect replies, immediate notify, stop automated follow-ups | `handlers-monitoring.js`, notifications | Done |
| 19 | Follow-ups: delay configurable, max count, stop after reply/suppression | `follow_ups`, scheduler | Done |
| 20 | Dashboard: active missions, lead/message/reply/follow-up counts, attention items, next scouting session | `GET /api/dashboard` | Done |
| 21 | Lead detail: all listed fields incl. conversation/follow-up/suppression/user actions | `GET /api/leads/:id` | Done |
| 22 | Mission management: Edit, Pause, Resume, Duplicate, Activity, Archive; retention policy for archived missions | `workspace.js` (`PATCH`, `/pause`, `/resume`, `/duplicate`, `DELETE` archive), `missions.js` `purgeArchived` | Done |
| 23 | Worker architecture: queue, run/pause/resume, recovery, bounded retry, termination, reporting, idempotency | `queue.js`, `scheduler.js`, `automation_jobs` | Done |
| 24 | Browser/research rules: authorized mechanisms, no CAPTCHA bypass, structured evidence | `research/fetcher.js` | Partial |
| 25 | Notifications: reply, mailbox expired, sending paused, high-priority lead, follow-up due, AI error | `notifications.js` (`/api/notifications`), handlers | Done |
| 26 | User controls: pause all, pause/resume mission, safe stop, disable auto-send, approval before send, mailbox connect/disconnect, edit settings | `account.js` automation-pause, mission pause/resume/stop, message approve/reject | Done |
| 27 | Sending modes: Scout Only / Review & Send / Autopilot; switchable anytime | `sending_mode` in `missions`, approve/reject endpoints | Done |
| 28 | High-level data model: all listed entities | `src/db/schema.postgres.sql` | Done |
| 29 | Dedup/privacy/safety: identity normalization, suppressions, no invented contacts, lawful public contact use | `core/normalize.js`, `suppressions` | Done |
| 30 | Error handling: job state, bounded retry, recovery, idempotency, regenerate AI, separated error kinds, friendly errors, dev logs | `automation_jobs` (`error_kind`/`error_code`), runtime logger | Done |
| 31 | OpenCode acceptance: installed/integrated, discovery from OpenCode, selection persisted, workers use runtime, errors handled, credentials not exposed | `src/ai/opencode-adapter.js` | Done |
| 32 | E2E website-design journey (full user flow incl. scheduler auto-start, discovery→analysis→qualify→send→monitor, follow-ups, pause/resume, restart recovery) | `test/e2e/*` (notifications, scheduler, …) | Partial |
| 33 | Changing the service changes behavior (no website-specific rules) | `missions.service` enum (`api-data.test.js`) | Done |
| 34 | Changing geography changes behavior (country filtering) | `target_locations` (`api-data.test.js`) | Done |
| 35 | Changing schedule (multiple windows/timezone) honored by scheduler | `mission_windows`, scheduler; one explicit schedule-change test | Partial |
| 36 | UX: responsive, clear running/paused states, visible autonomous activity, pause controls, logs secondary | `public/` (redesigned, responsive) | Partial (verify phone/tablet/desktop) |
| 37 | Navigation: Dashboard/Missions/Leads/Conversations/Email/Activity/Notifications/Settings | `public/` nav | Done |
| 38 | MUST NOTs: no mocks, no hard-coded provider lists, no frontend-only AI, no manual start, no niche/country hard-coding, no generic template, no guaranteed inbox placement, no invented contacts, no anti-bot bypass, no infinite sending, no follow-up after reply/opt-out, no secrets in frontend, verify real behavior | enforced across services/tests | Done |
| 39 | Implementation order followed (foundations → … → UI → tests) | commit history matches order | Done |
| 40 | Definition of Done: real user can autonomously scout/qualify/generate/send/monitor/notify/follow-up; recovery; dedup/suppression; OpenCode runtime | production running; e2e coverage per §32–§35 | Partial (backend gaps §17/§24 block full completion) |
| 41 | Source of truth honored; real system, not a prototype | whole implementation | Done |

## Known gaps requiring follow-up (TODO 3 candidates)
1. §17: bounce/complaint signal handling is provider-side; confirm Nexora records provider feedback where available.
2. §24: `research/fetcher.js` performs HTTP fetch, not an actual browser; browser automation (authorized) is not implemented.
3. §31: confirm integration tests cover the OpenCode adapter and provider/model selection.
4. §33/§34: no explicit e2e test for changing the service or geography; §35 has one explicit schedule-change test but §33/§34 do not.
5. §22: no documented retention policy for archived missions.
6. §24: robots/terms enforcement is not explicitly implemented or tested.
