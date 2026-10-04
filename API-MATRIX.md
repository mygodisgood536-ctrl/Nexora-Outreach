# Nexora Outreach — Capability to Route Matrix (Stage 2 audit)

Audited 2026-10-04 against `spec-reference/spec.txt` sections 5–29.
Sources: `src/http/routes/account.js`, `src/http/routes/workspace.js`, `src/http/router.js`,
`src/http/server.js`.

Legend: **OK** = exposed, ownership-checked, CSRF-correct, tested.
**GAP** = missing or incomplete, with the work required.

---

## Cross-cutting guarantees (verified for every route)

| Guarantee | Where enforced | Status |
|---|---|---|
| Authentication | `Router.add` sets `auth: true` by default; `server.js` returns 401 before the handler runs. Only `PUBLIC` routes opt out. | OK |
| CSRF | `Router.add` sets `csrf: true` for every non-GET/HEAD route; `server.js` compares an HMAC of the session id in constant time. | OK |
| Ownership | Every workspace handler calls `requireUser(ctx)` and passes `user.id` into the owning service, or re-checks `conversation.user_id`. | OK |
| Body validation | `readJson` enforces JSON content type, object shape, and a 512 KB cap. | OK |
| Structured errors | `handleError` maps `AppError` to `{ error, message, kind, detail }`; unknown errors become a generic 500. | OK |
| 404 vs 405 | `Router.match` distinguishes unknown path from wrong method. | OK |
| ID validation | `toId()` rejects non-positive/non-integer ids with 422 rather than querying. | OK |

Public routes (correctly `auth:false, csrf:false`): `/api/health`,
`/api/auth/signup`, `/api/auth/login`, `/api/auth/recover`,
`/api/auth/username-available`, `/api/auth/security-question`,
`/api/email/:provider/callback` (browser redirect).

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
| Lockout on repeated failure | in `AuthService` | OK |
| **Re-issue a recovery code while signed in** | — | **GAP-4** |

GAP-4: `AuthService.issueRecoveryCode()` exists but nothing exposes it. A user who
loses their recovery code has no way to obtain a new one, permanently losing account
recovery. Needs `POST /api/auth/recovery-code` (authenticated, CSRF-protected).
---

## Section 6 — Mailbox connection

| Capability | Route | Status |
|---|---|---|
| Connection state (no secrets) | `GET /api/email/connections` | OK |
| Redirect URI | `GET /api/email/redirect-uri` | OK |
| Begin OAuth | `POST /api/email/:provider/connect` | OK |
| Callback (one-time signed state) | `GET /api/email/:provider/callback` | OK |
| Disconnect | `POST /api/email/:provider/disconnect` | OK |
| Show connection status | via `/api/auth/me` + `/api/dashboard` | OK |

Live provider verification is Stage 10 and explicitly out of scope here.

---

## Section 7 / 31 — OpenCode provider and model layer

| Capability | Route | Status |
|---|---|---|
| Live catalog + current selection | `GET /api/ai/settings` | OK |
| Select provider/model | `PUT /api/ai/settings` | OK |
| Runtime diagnostics (no credentials) | `GET /api/ai/diagnostics` | OK |

---

## Section 8 / 22 — Missions

| Capability | Route | Status |
|---|---|---|
| List (incl. archived) | `GET /api/missions` | OK |
| Create | `POST /api/missions` | OK |
| Read | `GET /api/missions/:id` | OK |
| Edit | `PATCH /api/missions/:id` | OK |
| Activate / Pause / Resume / Stop | `POST .../activate,pause,resume,stop` | OK |
| Duplicate | `POST /api/missions/:id/duplicate` | OK |
| Archive / Delete | `DELETE /api/missions/:id` | OK |
| Run now (through the real queue) | `POST /api/missions/:id/run-now` | OK |
| Mission activity | `GET /api/missions/:id/activity` | OK |
| View Leads | `GET /api/leads?missionId=` | OK |

---

## Section 9 / 10 — Country targeting and schedule

| Capability | Route | Status |
|---|---|---|
---

## Section 11–14 — Discovery, research, analysis, qualification

| Capability | Route | Status |
|---|---|---|
| Lead list with filters | `GET /api/leads` | OK |
| Lead detail: identity, location, source, contact route | `GET /api/leads/:id` | OK |
| Lead detail: website + presence analysis | `GET /api/leads/:id` | OK |
| Lead detail: qualification / why selected | `GET /api/leads/:id` | OK |

---

## Section 15 / 18 / 19 — Outreach, replies, follow-ups

| Capability | Route | Status |
|---|---|---|
| Conversation list | `GET /api/conversations` | OK |
| Conversation detail + message history | `GET /api/conversations/:id` | OK |
| Approve a drafted message (Review & Send) | `POST /api/messages/:id/approve` | OK |
| **Reject a drafted message** | — | **GAP-1** |
| **Lead detail: conversation history inline** | — | **GAP-2a** |
| **Lead detail: follow-up status** | — | **GAP-2b** |
| **Lead detail: suppression status** | — | **GAP-2c** |

GAP-1: section 21 lists "user actions" on lead detail and section 27 defines
Review & Send. A user can approve but never decline, so a draft a user disagrees with
is indistinguishable from one still awaiting review.

GAP-2a/2b/2c: section 21 requires lead detail to show conversation history, follow-up
status and suppression status. `/api/leads/:id` returns only the bare conversation row.
A client must make three extra calls (and cannot correlate them safely) to assemble
what the spec requires on one screen.

---

## Section 17 / 29 — Suppression

| Capability | Route | Status |
|---|---|---|
| List suppressions | `GET /api/suppressions` | OK |
| Add suppression | `POST /api/suppressions` | OK |
| Remove suppression | `DELETE /api/suppressions/:id` | OK |
| Opt-out via reply | automatic in `mailboxMonitorHandler` | OK |

---

## Section 20 — Dashboard

| Spec element | Present | Status |
|---|---|---|
| Active missions | `missions.active` | OK |
| Leads discovered | `leads.discovered` | OK |
| Leads qualified | `leads.qualified` | OK |
| Replies received | `conversations.replied` | OK |
| Follow-ups due | `conversations.followUpPending` | OK |
| Next scouting session | `nextScouting` | OK |
| **Websites analyzed** | — | **GAP-3a** |
| **Messages generated** | — | **GAP-3b** |
| Messages sent | `leads.sent` | PARTIAL (counts leads, not messages) |
| **Current scouting state** | — | **GAP-3c** |
| **Items requiring attention** | — | **GAP-3d** |

---

## Section 25 — Notifications

| Capability | Route | Status |
|---|---|---|
| List / unread filter | `GET /api/notifications` | OK |
| Mark one read | `POST /api/notifications/:id/read` | OK |
| Mark all read | `POST /api/notifications/read-all` | OK |

---

## Section 26 — User controls

| Capability | Route | Status |
|---|---|---|
| Pause All Automation | `POST /api/auth/automation-paused` | OK |
| Per-mission pause/resume/stop | mission routes | OK |
| Stop cancels queued work | `missions.stop` + queue | OK |

---

## Section 23 / 30 / 36 — Worker, errors, activity

| Capability | Route | Status |
|---|---|---|
| Job history + stats + audit trail | `GET /api/activity` | OK |
| Transient vs permanent classification | `AppError` taxonomy | OK |

---

## Gap summary

| ID | Gap | Section | Action |
|---|---|---|---|
| GAP-1 | No way to reject a drafted message | 21, 27 | Add `POST /api/messages/:id/reject` + `ConversationService.markRejected` |
| GAP-2a-c | Lead detail omits conversation history, follow-up status, suppression status | 21 | Enrich `GET /api/leads/:id` using existing services |
| GAP-3a-d | Dashboard omits websites analyzed, messages generated, current scouting state, items requiring attention | 20 | Enrich `GET /api/dashboard` using existing services |
| GAP-4 | No way to re-issue a recovery code while signed in | 5 | Add `POST /api/auth/recovery-code` using `AuthService.issueRecoveryCode` |

No duplicate business logic is to be introduced in routes; every fix calls the existing service.
| ISO-validated target locations | `POST`/`PATCH /api/missions` | OK |
| Multiple day/time windows with timezone | `POST`/`PATCH /api/missions` | OK |
| Next scouting session | `GET /api/dashboard` -> `nextScouting` | OK |