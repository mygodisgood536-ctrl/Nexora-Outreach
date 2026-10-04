# Nexora Outreach - Remaining Work Stage Plan

Authoritative source: `spec-reference/spec.txt` (sections 1-41; Definition of Done is section 40).

## Rules that govern this plan

1. One stage at a time. A stage is not complete until implemented AND verified AND tested.
2. A completed stage is LOCKED. Later stages do not revisit it unless a demonstrable regression appears.
3. If a later stage exposes a regression in a locked stage: record it, fix only that defect, run the
   minimum verification for that locked stage, relock it, and return immediately to the active stage.
4. Never start an expensive verification run and then kill it before it reports. Start it, let it
   finish, read the actual result, and act on it.
5. No mock integrations, no simulated success, no placeholder implementations, and no tests that
   merely test the test itself.

---

## Assessment: what is already genuinely complete

Inspected 2026-10-03. This is what actually exists and has been demonstrated to work.

| Area | Evidence | Verdict |
|---|---|---|
| Schema and migrations | 24 tables plus new `oauth_states` and `recovery_codes`; `npm run migrate` | Complete |
| Crypto, normalisation, time windows | `test/unit/core.test.js` (18 tests) | Complete |
| Job queue: idempotency, retry, lease, recovery, safe stop | `test/unit/queue.test.js` (14 tests) | Complete |
| Auth: signup, login, lockout, sessions, audit | `test/unit/auth.test.js` (13 tests) | Complete |
| Missions, leads, suppression | `test/unit/missions.test.js` (20 tests) | Complete |
| Discovery query construction and injection safety | `test/unit/discovery.test.js` (8 tests) | Complete |
| Autonomous pipeline: discovery, research, analysis, qualification, outreach, send | `test/e2e/pipeline.test.js` | Complete |
| Retry, lease expiry, restart recovery, pause, stop | `test/e2e/lifecycle.test.js` | Complete |
| Suppression, daily limits, replies, follow-ups | `test/e2e/policy.test.js` | Complete |
| Window and timezone scheduling | `test/e2e/scheduler.test.js` | Complete |
| HTTP API: 40 routes, sessions, CSRF, ownership, structured errors | `test/e2e/api.test.js`, `api-data.test.js`, `api-platform.test.js` | Complete |
| OAuth state: one-time, hashed, expiring | `src/email/provider.js` plus api-platform tests | Complete |
| Account recovery: one-time, session revocation, enumeration-safe | `src/services/auth.js` plus api tests | Complete |
| `npm start` boots API, scheduler, worker; graceful shutdown | live probe on port 4399 plus `test/e2e/api.test.js` | Complete |
| Spec section 33 service change, section 34 geography change | `test/e2e/api-data.test.js` | Complete |

### Not started or not complete

- **Frontend: nothing exists.** No HTML, CSS, or browser JavaScript anywhere in the repository.
  Spec sections 20 (Dashboard), 21 (Lead Detail), 22 (Mission Management), 36 (UX Requirements)
  and 37 (Navigation) are entirely unimplemented. This is the largest remaining block of work.
- Spec section 35 (changing schedule) has no dedicated test.
- Live structured-JSON OpenCode execution is unconfirmed against the real installed CLI.
- Live Google/Microsoft OAuth is blocked on credentials.
- `README.md` is stale; it still says "Still to build before the HTTP API and UI".
- Roughly 30 scratch files (`_*.log`, `_dbg.mjs`, `_smoke.mjs`, `_runall.ps1`, `_patch.ps1`)
  and a `data/smoke/` directory remain from debugging.

---

## Stage 1 - Baseline Verification and Repository Hygiene

**Objective:** Establish a trustworthy green baseline and remove debugging residue, before any new work.

**Files involved:** repository root (deletions only); no source changes expected.

**Requirements to complete**

1. Delete scratch artefacts: all `_*.log`, `_dbg.mjs`, `_smoke.mjs`, `_runall.ps1`, `_patch.ps1`,
   `_*.txt`, and the `data/smoke/` directory.
2. Confirm `.gitignore` covers `.data/`, `data/`, and any local environment files.
3. Run the full suite to completion (unit plus all e2e). Do not interrupt it.
4. Confirm 0 failures, 0 cancelled, 0 skipped.

**Tests required:** none new. The existing suite is the test.

**Verification required:** full `npm test` exit code 0; the summary reports `fail 0`.

**Acceptance criteria:** clean directory listing with no underscore-prefixed files; suite green;
no regression introduced by the session's `_sleep` and `app.js` changes.

**Definition of complete:** requirements 1 through 4 are all satisfied and observed, not assumed.

---

## Stage 2 - API Surface Audit and Gap Closure

**Objective:** Guarantee every backend capability the UI will need is exposed by a real, tested route.

**Files involved:** `src/http/routes/`, `test/e2e/api-*.test.js`.

**Requirements to complete**

1. Map each spec capability to its route: section 21 lead detail (conversation history, follow-up
   status, suppression status, user actions), section 22 Duplicate and Archive, section 26 Pause All,
   section 20 dashboard "items requiring attention" and "next scouting session", section 25
   notifications, section 29 suppressions, section 18 reply threads.
2. Add any genuinely missing route (for example, rejecting a pending `review_send` message) together
   with matching tests.
3. Confirm every route enforces ownership and CSRF, and that no route returns another user's data.

**Tests required:** one test per added route; a cross-user test for each new resource.

**Verification required:** run the three `api-*.test.js` files to completion; all green.

**Acceptance criteria:** the capability-to-route map is complete with no gaps, and no route is untested.

**Definition of complete:** map produced, gaps closed with tests, suite green.

---

## Stage 3 - Live Structured-JSON OpenCode Execution

**Objective:** Prove the real installed OpenCode CLI produces validated structured output through
`AIRuntime`, not only plain text.

**Files involved:** `scripts/probe-opencode.js`, `src/ai/opencode-adapter.js`, `src/ai/tasks.js`.
No fake transport.

**Requirements to complete**

1. Run the real CLI against a real task purpose (for example `qualify_lead`) and capture genuine output.
2. Confirm `extractJson` and the validators accept it, and that `ai_call_log` records the real model
   and attempt count.
3. Confirm a real CLI failure surfaces as a classified retryable or permanent error, not a crash.

**Tests required:** none mocked. The evidence is the probe output saved under `evidence/`.

**Verification required:** the probe runs against the installed binary and prints a passing structured result.

**Acceptance criteria:** the real CLI is verified end to end for at least one structured purpose,
with the evidence file committed.

**Definition of complete:** probe output shows valid structured JSON consumed by real validation code.
---

## Stage 4 - Frontend Foundation and Auth Screens

**Objective:** Serve a browser application from the existing server and deliver the account
lifecycle in the user interface.

**Files involved:** new `src/http/static.js`, new `public/` directory (index.html, CSS, JS modules),
`src/http/server.js`, `test/e2e/ui-*.test.js`.

**Requirements to complete**

1. Static asset serving from `public/` with correct content types, no directory traversal, and no
   effect on existing API routes.
2. Sign-up, login, and recovery screens wired to the real endpoints, including the one-time
   `recoveryCode` display at sign-up.
3. Session bootstrap via `/api/auth/me`; CSRF token stored and attached to every mutating request;
   401 responses redirect to login; logout works.
4. No secrets, no provider lists, and no AI logic in the browser.

**Tests required:** DOM-level tests driving the real application against the real server. Sign-up
shows a recovery code, login succeeds, a wrong answer shows the server's message, recovery revokes the
prior session, and an unauthenticated deep link redirects to login.

**Verification required:** the browser-side tests run and pass; server logs show real auth events.

**Acceptance criteria:** a user can register, log out, log in, and recover entirely through the UI.

**Definition of complete:** all listed auth flows are driven by UI tests against the real backend.

---

## Stage 5 - Dashboard and Navigation Shell (sections 20 and 37)

**Objective:** Make the autonomous system understandable at a glance.

**Files involved:** `public/` dashboard view, router and navigation shell,
`test/e2e/ui-dashboard.test.js`.

**Requirements to complete**

1. Navigation entries per section 37: Dashboard, Missions, Leads, Conversations, Email, Activity,
   Notifications, Settings.
2. The dashboard shows every section 20 element: active missions, leads discovered, qualified,
   websites analyzed, messages generated and sent, replies received, follow-ups due, items
   requiring attention, current scouting state, and next scouting session with timezone.
3. Clear Running, Paused, Scheduled, Waiting, Failed, and Completed states (section 36).
4. Visible autonomous activity; technical logs secondary, not primary (section 36).

**Tests required:** a UI test asserting each dashboard figure renders and matches the real
`/api/dashboard` payload; a state-badge test for each mission state.

**Verification required:** seed real data through the API, then assert the rendered values.

**Acceptance criteria:** every section 20 element is present and bound to real data.

**Definition of complete:** the dashboard test is green against real data.

---

## Stage 6 - Missions UI (section 22)

**Objective:** Full mission management in the browser.

**Files involved:** `public/` missions view and form, `test/e2e/ui-missions.test.js`.

**Requirements to complete**

1. Create a mission: natural-language objective, service, target countries and cities, counts,
   schedule windows, sending mode.
2. Edit, Pause, Resume, Duplicate, View Leads, View Activity, and Archive/Delete per section 22.
3. Obvious Pause and Stop controls (section 36).
4. Multiple days and time windows honoured, with the mission timezone shown.
5. Mailbox-connected state surfaced on the mission card.

**Tests required:** create, activate, pause, resume, duplicate, and archive driven through the UI,
each verified against persisted database state via the API.

**Verification required:** UI actions produce real API calls and real state changes.

**Acceptance criteria:** every section 22 action works from the UI.

**Definition of complete:** the missions UI test is green.

---

## Stage 7 - Leads and Lead Detail (section 21)

**Objective:** Complete lead inspection and user actions.

**Files involved:** `public/` leads list and lead detail, `test/e2e/ui-leads.test.js`.

**Requirements to complete**

1. List view with country and location, status, and discovery source.
2. Detail view shows every section 21 field: business name, website, country and location,
   discovery source, public contact route, website and online-presence analysis, observed
   opportunity, why Nexora selected the lead, generated message, send status, conversation history,
   follow-up status, suppression status, and user actions.
3. Approve a `review_send` message from the UI; suppression reflects real state.

**Tests required:** a UI test opening a real lead and asserting each section 21 field renders from
real API data; the approve action verified by a database read.

**Verification required:** UI actions produce real API calls and real state changes.

**Acceptance criteria:** all section 21 fields are rendered and bound to real data.

**Definition of complete:** the leads UI test is green.

---

## Stage 8 - Conversations, Email, Activity, Notifications, Settings (section 37)

**Objective:** Complete the remaining navigation surfaces.

**Files involved:** `public/` views for conversations, email, activity, notifications, and settings;
`test/e2e/ui-views.test.js`.

**Requirements to complete**

1. Conversations: thread history, reply state, opt-out state, follow-up schedule.
2. Email: connect, callback, and disconnect for Google and Microsoft; connection status; provider
   availability shown without exposing secrets.
3. Activity: job history with technical detail available but not primary (section 36).
4. Notifications: list, mark read, and read-all.
5. Settings: profile, timezone, AI provider and model selection from the live OpenCode catalog,
   diagnostics, Pause All Automation, suppressions, and recovery code re-issue.

**Tests required:** one UI test per view, each bound to real API data; an AI selection test proving
the catalog comes from OpenCode and that the selection persists.

**Verification required:** UI actions produce real API calls and real state changes.

**Acceptance criteria:** every section 37 destination is implemented and tested.

**Definition of complete:** all view tests are green.

---

## Stage 9 - Responsive Behaviour and UX States (section 36)

**Objective:** Satisfy the explicit responsiveness and state-clarity requirements.

**Files involved:** `public/` styles, `test/e2e/ui-responsive.test.js`.

**Requirements to complete**

1. Verified layout at phone, tablet, and desktop widths - asserted, not eyeballed.
2. Every state badge legible and distinguishable.
3. Visible autonomous activity; obvious Pause and Stop on every surface.
4. Useful progress and activity information without exposing raw logs by default.

**Tests required:** viewport-parameterised UI tests at three or more widths asserting no horizontal
overflow and that controls remain reachable.

**Verification required:** the responsive test passes at every breakpoint.

**Acceptance criteria:** tests pass at all widths.

**Definition of complete:** the responsive test is green at all breakpoints.

---

## Stage 10 - Live OAuth Verification (Credential-Gated)

**Objective:** Verify the real Google and Microsoft authorization flow end to end.

**Files involved:** `src/email/google.js`, `src/email/microsoft.js`, `.env.example`, `evidence/`.

**Requirements to complete**

1. If `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are present: run the real connect, consent,
   callback, token-store, and send flow. Confirm tokens are encrypted at rest and never returned to
   the browser.
2. The same for Microsoft.
3. If credentials are absent: do NOT fake it. Record precisely what is blocked, what the integration
   boundary does, and the exact setup steps required.

**Tests required:** existing offline OAuth tests must stay green; the live flow is verified by
recorded evidence only.

**Verification required:** real flow proven against the provider, or an accurate blocked record.

**Acceptance criteria:** either real live verification with evidence, or an explicit and accurate
blocked-with-remediation record. Never a simulated success.

**Definition of complete:** the outcome is documented either way, and no fake integration exists in code.

---

## Stage 11 - Full End-to-End Lifecycle and Spec Sections 32 and 35

**Objective:** Prove the Definition of Done narrative works through the real application.

**Files involved:** `test/e2e/full-lifecycle.test.js`, plus a section 35 schedule-change test.

**Requirements to complete**

1. A real account: sign up, connect a mailbox, create a mission from a natural-language objective,
   select service, targets, countries, and schedule, then activate it.
2. Autonomous behaviour: discover, investigate, qualify, generate individualized outreach, send,
   monitor for replies, notify the user, and follow up.
3. The section 32 website-designer end-to-end scenario.
4. Section 35: change the schedule. Multiple days and windows, timezone honoured, and runs
   automatically with no daily manual start (section 38).
5. Restart and failure recovery proven in the same run; duplicate and suppressed outreach prevented.

**Tests required:** one long integration test asserting real persisted state at each transition,
plus a dedicated section 35 test.

**Verification required:** the full suite is green including this file; the evidence log is retained.

**Acceptance criteria:** every clause of section 40 is satisfied by an assertion.

**Definition of complete:** the lifecycle and section 35 tests are green.

---

## Stage 12 - Production Readiness

**Objective:** Harden configuration and failure behaviour before declaring completion (section 41).

**Files involved:** `src/config.js`, `.env.example`, `README.md`, `src/http/server.js`, `package.json`.

**Requirements to complete**

1. `TOKEN_ENCRYPTION_KEY` is required in production and validated at boot.
2. No secret is reachable from the browser; verified by test.
3. Structured errors never leak stack traces or internals to clients.
4. Graceful shutdown on SIGINT and SIGTERM - already implemented; verify it, do not rebuild it.
5. `npm start` and `npm test` work from a clean checkout.
6. Rate limiting and lockout verified under repeated real requests.

**Tests required:** boot without a key fails loudly in production mode; a no-leak test; a
clean-checkout run.

**Verification required:** each of the six requirements demonstrated with recorded evidence.

**Acceptance criteria:** all six verified.

**Definition of complete:** the production-readiness checks pass.

---

## Stage 13 - Documentation and Final Certification

**Objective:** Accurate documentation and a final, honest completion report.

**Files involved:** `README.md`, `evidence/`.

**Requirements to complete**

1. `README.md` reflects the real current state: what is built, how to run it, how to configure OAuth,
   and the known limitations.
2. Remove the stale "Still to build before the HTTP API and UI" section.
3. Every section 38 "must not do" constraint explicitly confirmed as honoured.
4. A final report listing each stage, its evidence, and any residual limitation such as
   credential-gated OAuth.

**Tests required:** none. Documentation accuracy is verified against the code.

**Verification required:** a reviewer can follow the README from a clean checkout and reach a
---

## Completion Record

| Stage | Implementation | Tests | Verification | Status | Evidence |
|---|---|---|---|---|---|
| 1. Baseline and hygiene | Scratch removed; `.gitignore` created; 3 defects fixed | 147 total (71 unit + 76 e2e) | `npm test` exit 0, 147 pass / 0 fail / 0 cancelled | **LOCKED** | See Stage 1 evidence below |
| 2. API surface audit | 40 routes exist | 32 API tests green | per-file runs | NEEDS AUDIT | - |
| 3. Live OpenCode structured JSON | adapter exists, unverified | none | probe only | NOT VERIFIED | - |
| 4. Frontend foundation and auth | nothing exists | none | none | NOT STARTED | - |
| 5. Dashboard and navigation | nothing exists | none | none | NOT STARTED | - |
| 6. Missions UI | nothing exists | none | none | NOT STARTED | - |
| 7. Leads and lead detail | nothing exists | none | none | NOT STARTED | - |
| 8. Conversations, Email, Activity, Notifications, Settings | nothing exists | none | none | NOT STARTED | - |
| 9. Responsive and UX states | nothing exists | none | none | NOT STARTED | - |
| 10. Live OAuth | boundary exists | offline tests green | credential-gated | BLOCKED ON SECRETS | - |
| 11. Full lifecycle and sections 32, 35 | 32, 33, 34 done | partial | partial | PARTIAL | - |
| 12. Production readiness | partial | partial | partial | NOT STARTED | - |
| 13. Documentation and certification | README stale | none | none | NOT STARTED | - |

**Active stage: 1 is LOCKED. Stage 2 (API surface audit) is the next candidate and has NOT been started.**

---

## Stage 1 Evidence (locked 2026-10-04)

**Repository hygiene**

- Removed all scratch artefacts: ~30 `_*.log` files, `_dbg.mjs`, `_smoke.mjs`, `_runall.ps1`,
  `_patch.ps1`, and the `data/smoke ` directory (literally named with a trailing space, which required
  the `\\?\` extended-path prefix to delete).
- Removed the now-empty `data/` directory.
- Created `.gitignore` (none existed) covering `.data/`, `data/`, `.env` (with `!.env.example`),
  `node_modules/`, and logs.
- Final repository root contains only: `.data`, `.env.example`, `.gitignore`, `evidence`,
  `package.json`, `README.md`, `scripts`, `spec-reference`, `src`, `STAGE-PLAN.md`, `test`.

**Defects found by this verification and fixed**

1. `test/helpers/api.js` - `startTestApp()` created a second HTTP listener on top of the one from
   `startTestServer()`. The orphaned listener kept the test process alive forever, so the aggregate
   `npm run test:e2e` never terminated. Fixed by extracting `createTestSystem()`, which builds the
   system and fakes without opening a listener. **This was the root cause of the repeated hangs.**
2. `test/helpers/api.js` - `base`/`port` were getters reading `server.address()`, which returns `null`
   after shutdown, so the "listener is closed" assertion threw instead of rejecting the fetch. Now
   captured once at startup as plain values.
3. `src/services/auth.js` - **real product defect.** `formatRecoveryCode` stripped `-` from a
   base64url token but not `_`, producing codes such as `N6FIX-WBBTN-KX9L_-PRVM`. A recovery code a
   human must write down and retype should not contain ambiguous glyphs. Replaced with a
   Crockford-style alphabet (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, no I/L/O/U) using rejection
   sampling for an unbiased distribution; `randomBytes` is now exported from `src/core/crypto.js`.

**Verification results (single clean run of the documented entry point `npm test`)**

| Suite | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| unit | 71 | 71 | 0 | 0 | 0 |
| e2e | 76 | 76 | 0 | 0 | 0 |
| **total** | **147** | **147** | **0** | **0** | **0** |

`NPM_TEST_EXIT=0`.

Per-file results (each run in isolation, also green):

| File | Result |
|---|---|
| `test/unit/*.test.js` | 71/71 |
| `test/e2e/api.test.js` | 15/15 |
| `test/e2e/api-data.test.js` | 10/10 |
| `test/e2e/api-platform.test.js` | 14/14 |
| `test/e2e/lifecycle.test.js` | 8/8 |
| `test/e2e/pipeline.test.js` | 6/6 |
| `test/e2e/policy.test.js` | 12/12 |
| `test/e2e/scheduler.test.js` | 11/11 |

Note on the earlier hang: `node --test` runs multiple files in parallel child processes, so one
non-exiting child (defect 1 above) stalled the whole run. Once fixed, the aggregate run completes
normally. No environmental cause remains outstanding.

---

## Stage Report Template

Every stage closes with a report in exactly this shape:

```
STAGE
IMPLEMENTED
VERIFIED
TEST RESULTS
REMAINING IN THIS STAGE
STATUS
LOCKED: YES/NO
NEXT STAGE
```

If `REMAINING IN THIS STAGE` is anything other than "none", the status stays incomplete and work
continues in that same stage. Forward movement happens only when the stage is LOCKED.

running system.

**Acceptance criteria:** the README matches reality, with no overstated claims.

**Definition of complete:** all thirteen stages are LOCKED.

