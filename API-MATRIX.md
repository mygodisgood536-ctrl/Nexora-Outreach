# Nexora Outreach — Capability to Route Matrix

Audited against `spec-reference/spec.txt` (sections 5–31).
Sources: `src/http/routes/{account,workspace,system}.js`, `src/http/router.js`,
`src/http/server.js`, `public/`.

Legend: **OK** = exposed, ownership-checked, CSRF-correct, tested.
**GAP** = missing or incomplete, with the work required.

> **Re-audit note.** The Stage-2 audit found four gaps (GAP-1 … GAP-4). All four
> are now **closed**; the resolution is recorded inline and summarised at the
> end. Newly added surfaces since that audit: mission interpretation, delivery
> event ingestion, the serverless cron driver, and the single-page frontend.

---

## Cross-cutting guarantees (verified for every route)

| Guarantee | Where enforced | Status |
|---|---|---|
| Authentication | `Router.add` defaults `auth: true`; `server.js` returns 401 before the handler runs. Only `PUBLIC` routes opt out. | OK |
| CSRF | `Router.add` defaults `csrf: true` for non-GET/HEAD; `server.js` compares an HMAC of the session id in constant time. | OK |
| Ownership | Every workspace handler calls `requireUser(ctx)` and passes `user.id` to the owning service, or re-checks `conversation.user_id`. | OK |
| Body validation | `readJson` enforces JSON content type, object shape, and a 512 KB cap. | OK |
| Structured errors | `handleError` maps `AppError` to `{ error, message, detail }`; unknown errors become a generic 500. | OK |
| 404 vs 405 | `Router.match` distinguishes unknown path from wrong method. | OK |
| ID validation | `toId()` rejects non-positive/non-integer ids with 422 before querying. | OK |

Public routes (correctly `auth:false, csrf:false`): `/health`, `/api/health`,
`/api/auth/signup`, `/api/auth/login`, `/api/auth/recover`,
`/api/auth/username-available`, `/api/auth/security-question`,
`/api/email/:provider/callback`, `/api/email/events` (webhook or session),
`/api/cron/tick` (bearer secret).

---

## Section 5 — Account creation and login

| Capability | Route | Status |
|---|---|---|
| Sign up | `POST /api/auth/signup` | OK (returns one-time `recoveryCode`) |
| Username availability | `GET /api/auth/username-available` | OK |
| Security question lookup | `GET /api/auth/security-question` | OK |
| Login by security answer | `POST /api/auth/login` | OK |
| Logout / revoke | `POST /api/auth/logout` | OK |
| Current session + CSRF token | `GET /api/auth/me` | OK |
| Profile / timezone | `PATCH /api/auth/profile` | OK |
| Re-issue a recovery code while signed in | `POST /api/auth/recovery-code` | OK (**GAP-4 closed**) |
| Lockout on repeated failure | `AuthService` | OK |

---

## Section 6 — Mailbox connection

| Capability | Route | Status |
|---|---|---|
| Connection state (no secrets) | `GET /api/email/connections` | OK |
| Redirect URI | `GET /api/email/redirect-uri` | OK |
| Begin OAuth | `POST /api/email/:provider/connect` | OK |
| Callback (one-time signed state) | `GET /api/email/:provider/callback` | OK |
| Disconnect | `POST /api/email/:provider/disconnect` | OK |

---

## Section 7 / 31 — OpenCode provider and model layer

| Capability | Route | Status |
|---|---|---|
| Live catalog + current selection | `GET /api/ai/settings` | OK |
| Select provider/model | `PUT /api/ai/settings` | OK |
| Runtime diagnostics (no credentials) | `GET /api/ai/diagnostics` | OK |
| Serverless-capable HTTP transport | `src/ai/transport.js` | OK (model pending) |

---

## Section 8 / 22 — Missions

| Capability | Route | Status |
|---|---|---|
| List (incl. archived) | `GET /api/missions?includeArchived=1` | OK |
| Create | `POST /api/missions` | OK |
| Interpret plain-language objective | `POST /api/missions/interpret` | OK (AI-gated) |
| Read | `GET /api/missions/:id` | OK |
| Edit | `PATCH /api/missions/:id` | OK |
| Activate / Pause / Resume / Stop | `POST /api/missions/:id/{activate,pause,resume,stop}` | OK |
| Duplicate | `POST /api/missions/:id/duplicate` | OK |
| Delete | `DELETE /api/missions/:id` | OK |
| Run now (through the real queue) | `POST /api/missions/:id/run-now` | OK |
| Mission activity | `GET /api/missions/:id/activity` | OK |

---

## Section 9 / 10 — Country targeting and schedule

| Capability | Route | Status |
|---|---|---|
| ISO-validated target locations | `POST`/`PATCH /api/missions` | OK |
| Multiple day/time windows with timezone | `POST`/`PATCH /api/missions` | OK |
| Next scouting session | `GET /api/dashboard` → `nextScouting` | OK |

---

## Section 11–14 — Discovery, research, analysis, qualification

| Capability | Route | Status |
|---|---|---|
| Lead list with filters | `GET /api/leads?missionId=&status=` | OK |
| Lead detail: identity, location, source, contact route | `GET /api/leads/:id` | OK |
| Lead detail: website + presence analysis | `GET /api/leads/:id` | OK |
| Lead detail: qualification / why selected | `GET /api/leads/:id` | OK |

---

## Section 15 / 18 / 19 / 21 — Outreach, replies, follow-ups

| Capability | Route | Status |
|---|---|---|
| Conversation list | `GET /api/conversations` | OK |
| Conversation detail + message history | `GET /api/conversations/:id` | OK |
| Approve a drafted message | `POST /api/messages/:id/approve` | OK |
| Reject a drafted message | `POST /api/messages/:id/reject` | OK (**GAP-1 closed**) |
| Lead detail: conversation history inline | `GET /api/leads/:id` → `messages` | OK (**GAP-2a closed**) |
| Lead detail: follow-up status | `GET /api/leads/:id` → `followUps` | OK (**GAP-2b closed**) |
| Lead detail: suppression status | `GET /api/leads/:id` → `suppression` | OK (**GAP-2c closed**) |

---

## Section 17 / 29 — Suppression and delivery events

| Capability | Route | Status |
|---|---|---|
| List suppressions | `GET /api/suppressions` | OK |
| Add suppression | `POST /api/suppressions` | OK |
| Remove suppression | `DELETE /api/suppressions/:id` | OK |
| Report a bounce/complaint (session or webhook) | `POST /api/email/events` | OK |
| Opt-out via reply | `mailboxMonitorHandler` | OK |

---

## Section 20 — Dashboard

| Spec element | Field | Status |
|---|---|---|
| Active missions | `missions.active` | OK |
| Leads discovered / qualified | `leads.discovered`, `leads.qualified` | OK |
| Websites analysed | `websitesAnalyzed` | OK (**GAP-3a closed**) |
| Messages generated / sent | `messages.generated`, `messages.sent` | OK (**GAP-3b closed**) |
| Replies received | `conversations.replied` | OK |
| Follow-ups due / pending | `conversations.followUpsDue`, `followUpPending` | OK |
| Current scouting state | `scoutingState` | OK (**GAP-3c closed**) |
| Items requiring attention | `attention[]` | OK (**GAP-3d closed**) |
| Next scouting session | `nextScouting[]` | OK |

---

## Section 25 — Notifications

| Capability | Route | Status |
|---|---|---|
| List / unread filter | `GET /api/notifications` | OK |
| Mark one read | `POST /api/notifications/:id/read` | OK |
| Mark all read | `POST /api/notifications/read-all` | OK |

---

## Section 26 — User controls and serverless driver

| Capability | Route | Status |
|---|---|---|
| Pause all automation | `POST /api/auth/automation-paused` | OK |
| Per-mission pause/resume/stop | mission routes | OK |
| Advance the pipeline on a schedule (serverless) | `GET`/`POST /api/cron/tick` | OK |

---

## Section 30 / 36 — Activity and operations

| Capability | Route | Status |
|---|---|---|
| Job history + stats + audit trail | `GET /api/activity` | OK |
| Health (JSON) | `/health`, `/api/health` | OK |
| Static SPA + deep-link fallback | `/`, `/styles.css`, `/app.js`, `/:route` | OK |

---

## Frontend surface (§20–22, §35–37)

| View | Route (hash) | Backing endpoints | Status |
|---|---|---|---|
| Auth (sign in / up / recover) | `#/` when signed out | section 5 routes | OK |
| Command dashboard | `#/dashboard` | `GET /api/dashboard` | OK |
| Missions + new-mission wizard | `#/missions` | section 8 routes + interpret | OK |
| Mission detail + lifecycle | `#/missions/:id` | mission routes + activity + leads | OK |
| Prospects + filters | `#/leads` | `GET /api/leads` | OK |
| Lead detail | `#/leads/:id` | `GET /api/leads/:id` | OK |
| Inbox + thread + approve/reject | `#/inbox`, `#/inbox/:id` | conversations + messages | OK |
| Signals (notifications) | `#/notifications` | section 25 routes | OK |
| Control (AI, mailbox, pause, recovery, suppressions) | `#/settings` | sections 6, 7, 17, 26 | OK |
| Responsive / mobile drawer | all | — | OK |

---

## Gap summary

| ID | Gap | Section | Resolution | Status |
|---|---|---|---|---|
| GAP-1 | No way to reject a drafted message | 21, 27 | `POST /api/messages/:id/reject` + `ConversationService.markRejected` | **CLOSED** |
| GAP-2a-c | Lead detail omitted conversation history, follow-ups, suppression | 21 | `GET /api/leads/:id` now returns `messages`, `followUps`, `suppression` | **CLOSED** |
| GAP-3a-d | Dashboard omitted websites analysed, messages generated, scouting state, attention items | 20 | `GET /api/dashboard` enriched | **CLOSED** |
| GAP-4 | No way to re-issue a recovery code while signed in | 5 | `POST /api/auth/recovery-code` | **CLOSED** |

No duplicate business logic is introduced in routes; every route delegates to an
existing service.