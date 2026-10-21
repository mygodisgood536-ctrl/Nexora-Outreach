// ============================================================
// Nexora Outreach — command center SPA
// Zero dependencies. Hash-routed. Talks only to /api/*.
// ============================================================

const app = document.getElementById('app');
const toastsEl = document.getElementById('toasts');
const modalRoot = document.getElementById('modal-root');

const state = { user: null, csrf: null, email: [], navOpen: false };

// ── utilities ───────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toDate(v) {
  if (!v) return null;
  let s = String(v);
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
const fmtDate = (v) => { const d = toDate(v); return d ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'; };
function fmtRel(v) {
  const d = toDate(v);
  if (!d) return '—';
  const s = Math.round((d.getTime() - Date.now()) / 1000);
  const a = Math.abs(s);
  const val = a < 60 ? a + 's'
    : a < 3600 ? Math.round(a / 60) + 'm'
      : a < 86400 ? Math.round(a / 3600) + 'h'
        : Math.round(a / 86400) + 'd';
  return s >= 0 ? `in ${val}` : `${val} ago`;
}
const titleCase = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const num = (n) => Number(n || 0).toLocaleString();
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (d) => DAY[Number(d)] || String(d);
/** Windows are stored as minutes after midnight; people read "10:00". */
const minutesToTime = (m) => {
  const n = Number(m);
  if (!Number.isFinite(n)) return String(m ?? '');
  const h = Math.floor(((n % 1440) + 1440) % 1440 / 60);
  const mm = ((n % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};
/** Stage ids are machine names; the reader sees a sentence. */
const STAGE_LABELS = {
  discovery: 'Discovery', research: 'Research', site_analysis: 'Website analysis',
  presence_analysis: 'Presence check', qualification: 'Qualification', outreach: 'Outreach drafting',
  email: 'Sending', follow_up: 'Follow-up', mailbox_monitor: 'Reply monitoring',
  approval: 'Awaiting approval', retention: 'Housekeeping',
};
const stageLabel = (s) => STAGE_LABELS[s] || titleCase(s || 'work');
/**
 * A raw failure string ("REQUEST TO X FAILED: FETCH FAILED") is noise. The
 * operator needs the cause in a sentence, so the noisy part is dropped.
 */
const plainFailure = (text) => {
  const s = String(text || '').trim();
  if (!s) return '';
  const cleaned = s
    .replace(/^request to .*? failed[:\s]*/i, 'The site could not be reached — ')
    .replace(/\bfetch failed\b/gi, 'the connection failed')
    .replace(/\bgetaddrinfo [a-z0-9_ -]+\b/gi, 'the address could not be resolved')
    .replace(/^([a-z])/, (c) => c.toUpperCase());
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
};

function toast(message, kind = 'ok', title = null) {
  const div = document.createElement('div');
  div.className = `toast ${kind === 'err' ? 'err' : 'ok'}`;
  div.innerHTML = `${title ? `<div class="t-title">${esc(title)}</div>` : ''}${esc(message)}`;
  toastsEl.appendChild(div);
  setTimeout(() => { div.style.opacity = '0'; setTimeout(() => div.remove(), 220); }, kind === 'err' ? 6000 : 3600);
}

// ── API client ──────────────────────────────────────────────
class ApiError extends Error {
  constructor(status, code, message, detail) { super(message || 'Request failed'); this.status = status; this.code = code; this.detail = detail; }
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  if (method !== 'GET' && state.csrf) opts.headers['X-CSRF-Token'] = state.csrf;

  const res = await fetch(path, opts);
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text }; } }

  if (res.status === 401) {
    state.user = null;
    throw new ApiError(401, 'UNAUTHENTICATED', 'Your session expired. Please sign in again.');
  }
  if (!res.ok) throw new ApiError(res.status, data?.error, data?.message || `Request failed (${res.status})`, data?.detail);
  return data;
}

// ── modal ───────────────────────────────────────────────────
function openModal(html) {
  modalRoot.innerHTML = `<div class="modal-back"><div class="modal">${html}</div></div>`;
  const back = modalRoot.firstElementChild;
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); });
  return back.querySelector('.modal');
}
const closeModal = () => { modalRoot.innerHTML = ''; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); state.navOpen = false; if (state.user) render(); } });

// ── routing ─────────────────────────────────────────────────
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { path: parts[0] || 'dashboard', id: parts[1] ? Number(parts[1]) : null };
}
function go(hash) {
  state.navOpen = false;
  if (location.hash === `#/${hash}`) render(); else location.hash = `#/${hash}`;
}
window.addEventListener('hashchange', () => render());

// ── badges ──────────────────────────────────────────────────
const TONE = {
  discovered: 'faint', investigated: 'faint', analyzed: 'violet', qualified: 'cyan',
  message_generated: 'violet', awaiting_approval: 'amber', sent: 'green', replied: 'green',
  suppressed: 'red', closed: 'faint', failed: 'red',
  draft: 'faint', scheduled: 'cyan', running: 'green', paused: 'amber', stopped: 'faint',
  completed: 'green', archived: 'faint',
  queued: 'faint', succeeded: 'green', received: 'cyan', reply_received: 'green',
};
const badge = (text, tone) => `<span class="badge ${tone || TONE[text] || 'faint'}">${esc(titleCase(text))}</span>`;
const toneOf = (s) => TONE[s] || 'faint';

// ── shell ───────────────────────────────────────────────────
// Icons are inline SVG rather than unicode glyphs: a dingbat only renders on
// the fonts that ship that exact codepoint, so a missing glyph silently
// degrades the whole navigation into a column of "?" boxes.
const ICONS = {
  dashboard: '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z"/>',
  missions: '<path d="M12 2.5l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 16.4 6.4 19.6l1.4-6.3L3 9l6.4-.6z"/>',
  leads: '<path d="M12 21s7-5.3 7-11a7 7 0 10-14 0c0 5.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M3 13l2.6-7.4A2 2 0 017.5 4.5h9a2 2 0 011.9 1.4L21 13v5.5a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  email: '<path d="M3 7.5l9 6 9-6"/><rect x="3" y="4.5" width="18" height="15" rx="2.5"/>',
  activity: '<path d="M3 12h4l2.5-7 4 14 2.5-7h5"/>',
  notifications: '<path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 19a2 2 0 004 0"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M21.2 12h-3M5.8 12h-3M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1M18.5 18.5l-2.1-2.1M7.6 7.6L5.5 5.5"/>',
};
const icon = (id) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[id] || ''}</svg>`;

const NAV = [
  { id: 'dashboard', label: 'Command', icon: 'dashboard' },
  { id: 'missions', label: 'Missions', icon: 'missions' },
  { id: 'leads', label: 'Prospects', icon: 'leads' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'email', label: 'Email', icon: 'email' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'notifications', label: 'Signals', icon: 'notifications', count: 'unread' },
  { id: 'settings', label: 'Control', icon: 'settings' },
];
const navCounts = { unread: 0 };

/**
 * The page title must be the same word the navigation uses. Deriving it from
 * the route id instead left every screen called something different from its
 * own menu entry (Leads/Prospects, Signals/Notifications, Command/Dashboard).
 */
const navLabel = (path) => {
  const id = String(path || '').split('/')[0];
  return (NAV.find((n) => n.id === id) || {}).label || titleCase(id);
};

function shell(inner) {
  const r = route();
  return `
  <div class="shell ${state.navOpen ? 'nav-open' : ''}">
    ${state.navOpen ? '<div class="scrim" data-act="close-nav"></div>' : ''}
    <aside class="sidebar">
      <div class="brand" style="padding-left:6px">
        <img src="/favicon.svg" alt="" />
        <div><div class="name">Nexora</div><div class="sub">Outreach</div></div>
      </div>
      <nav class="nav">
        ${NAV.map((n) => `
          <a href="#/${n.id}" class="${r.path === n.id ? 'active' : ''}">
            <span class="ico">${icon(n.icon)}</span>${n.label}
            ${n.count && navCounts[n.count] ? `<span class="count">${navCounts[n.count]}</span>` : ''}
          </a>`).join('')}
      </nav>
      <div class="spacer"></div>
      <div class="who">
        <b>${esc(state.user?.fullName || '')}</b>@${esc(state.user?.username || '')}
      </div>
      <button class="btn block" data-act="logout" style="margin-top:8px">Sign out</button>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="btn hamburger" data-act="open-nav">☰</button>
        <div>
          <div class="title">${esc(navLabel(r.path))}</div>
          <div class="sub">Autonomous prospecting console</div>
        </div>
        <div class="grow"></div>
        <button class="btn" data-act="refresh">↻ Refresh</button>
      </header>
      <main class="view" id="view">${inner}</main>
    </div>
  </div>`;
}

const setView = (html) => { const v = document.getElementById('view'); if (v) v.innerHTML = html; };
const loadingView = () => `<div class="empty"><div class="big">Establishing link…</div><div>Loading data from the command core.</div></div>`;

// ── render loop ─────────────────────────────────────────────
async function render() {
  if (!state.user) return renderAuth();
  app.innerHTML = shell(loadingView());
  // The shell is painted, so the splash has done its job. Data streams in
  // behind it from here; the screen must never be blocked by a slow API.
  hideSplash();
  try {
    await renderRoute();
  } catch (e) {
    setView(`<div class="empty"><div class="big">Could not load this view</div><div>${esc(e.message)}</div></div>`);
    if (e.status !== 401) toast(e.message, 'err', 'Load failed');
  }
}
async function renderRoute() {
  const r = route();
  switch (r.path) {
    case 'dashboard': return renderDashboard();
    case 'missions': return r.id ? renderMissionDetail(r.id) : renderMissions();
    case 'leads': return r.id ? renderLeadDetail(r.id) : renderLeads();
    case 'inbox': return r.id ? renderConversation(r.id) : renderInbox();
    case 'email': return renderEmail();
    case 'activity': return renderActivity();
    case 'notifications': return renderNotifications();
    case 'settings': return renderSettings();
    default: return go('dashboard');
  }
}

// ============================================================
// AUTH
// ============================================================
let authTab = 'login';
function renderAuth() {
  const tabs = [['login', 'Sign in'], ['signup', 'Create account'], ['recover', 'Recover']];
  const forms = {
    login: `
      <form data-form="login">
        <label class="small muted">Username</label>
        <input name="username" autocomplete="username" required placeholder="ada" />
        <div style="height:12px"></div>
        <label class="small muted">Security answer</label>
        <input name="securityAnswer" type="password" autocomplete="off" required placeholder="Your security answer" />
        <div style="height:18px"></div>
        <button class="btn block" type="submit">Enter command center</button>
      </form>`,
    signup: `
      <form data-form="signup">
        <label class="small muted">Full name</label>
        <input name="fullName" required placeholder="Ada Lovelace" />
        <div style="height:12px"></div>
        <label class="small muted">Username</label>
        <input name="username" required placeholder="letters, numbers, _ or -" />
        <div id="uname-hint" class="small faint" style="margin-top:5px;min-height:14px"></div>
        <label class="small muted">Security question</label>
        <input name="securityQuestion" required placeholder="A question only you can answer" />
        <div style="height:12px"></div>
        <label class="small muted">Security answer</label>
        <input name="securityAnswer" required placeholder="Your secret answer" />
        <div style="height:18px"></div>
        <button class="btn block" type="submit">Provision account</button>
      </form>`,
    recover: `
      <form data-form="recover">
        <label class="small muted">Username</label>
        <input name="username" required placeholder="ada" />
        <div style="height:12px"></div>
        <label class="small muted">Recovery code</label>
        <input name="recoveryCode" required placeholder="shadmin once, shown at signup" />
        <div style="height:12px"></div>
        <label class="small muted">New security answer</label>
        <input name="newSecurityAnswer" required placeholder="A new secret answer" />
        <div style="height:18px"></div>
        <button class="btn block" type="submit">Recover access</button>
      </form>`,
  };

  app.innerHTML = `
    <div class="welcome">
      <section class="welcome-hero">
        <span class="eyebrow">AI outreach autopilot</span>
        <h1 class="display-xl">Find the right businesses. <em>Reach them personally.</em> Follow up automatically.</h1>
        <p class="lead">Nexora discovers prospects, investigates their public presence, writes outreach in your voice, monitors for replies and follows up — on a schedule you control.</p>
        <ul class="hero-list">
          <li><span class="ico">◎</span><div><b>Scout &amp; qualify</b><div class="faint small">Every candidate is researched and scored against your mission before any message is written.</div></div></li>
          <li><span class="ico">✍</span><div><b>Write &amp; send</b><div class="faint small">Personalised outreach in scout-only, review-and-send, or full autopilot mode.</div></div></li>
          <li><span class="ico">↺</span><div><b>Monitor &amp; follow up</b><div class="faint small">Replies are detected, follow-ups are scheduled, and you are told when anything needs you.</div></div></li>
        </ul>
      </section>

      <section class="welcome-auth">
        <div class="brand-mark">
          <img src="/favicon.svg" alt="" />
          <div class="word">Nexora<small>Outreach</small></div>
        </div>
        <div class="tabs">${tabs.map(([id, l]) => `<button class="${authTab === id ? 'on' : ''}" data-act="auth-tab" data-tab="${id}">${l}</button>`).join('')}</div>
        <div class="panel pad-lg">${forms[authTab] || forms.login}</div>
      </section>
    </div>`;

  if (authTab === 'signup') {
    const uname = document.querySelector('input[name="username"]');
    let t;
    uname?.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const hint = document.getElementById('uname-hint');
        const value = uname.value.trim();
        if (!value) { hint.textContent = ''; return; }
        try {
          const r = await api(`/api/auth/username-available?username=${encodeURIComponent(value)}`);
          hint.textContent = r.available ? '✓ available' : r.reason;
          hint.style.color = r.available ? 'var(--green)' : 'var(--red)';
        } catch { hint.textContent = ''; }
      }, 350);
    });
  }
}

async function afterAuth(user) {
  state.user = user;
  const me = await api('/api/auth/me');
  state.user = me.user;
  state.csrf = me.csrfToken;
  state.email = me.email || [];
  go('dashboard');
}

// ============================================================
// DASHBOARD
// ============================================================
/**
 * The first-run journey (§3/§5): a brand-new account is walked from an empty
 * console to a live mission. It is derived from real state, so it disappears on
 * its own once the three steps are genuinely done.
 */
function onboardingPanel(dash, attention) {
  const steps = [
    {
      done: !attention.some((a) => a.kind === 'mailbox_not_connected'),
      title: 'Connect a mailbox',
      hint: 'Nexora sends through your own connected account.',
      cta: `<button class="btn small" data-nav="settings">Open Control</button>`,
    },
    {
      done: (dash.missions.total || 0) > 0,
      title: 'Create your first mission',
      hint: 'Describe what you sell and who you want to reach.',
      cta: `<button class="btn small" data-act="new-mission">＋ New mission</button>`,
    },
    {
      done: (dash.missions.active || 0) > 0,
      title: 'Activate it',
      hint: 'The scheduler begins scouting at the next send window.',
      cta: `<button class="btn small" data-nav="missions">View missions</button>`,
    },
  ];
  if (steps.every((s) => s.done)) return '';
  const doneCount = steps.filter((s) => s.done).length;
  return `<div class="panel" style="margin-bottom:18px">
    <div class="spread" style="margin-bottom:12px">
      <div>
        <div class="card-label">Getting started</div>
        <div class="display-md" style="margin-top:6px">Set up your first campaign</div>
      </div>
      <span class="badge cyan">${doneCount} of ${steps.length} done</span>
    </div>
    <div class="onboard-steps">
      ${steps.map((s, i) => `
        <div class="onboard-step ${s.done ? 'done' : ''}">
          <span class="step-num">${s.done ? '✓' : i + 1}</span>
          <div class="body"><b>${s.title}</b><span>${s.hint}</span></div>
          ${s.done ? '<span class="badge green">done</span>' : s.cta}
        </div>`).join('')}
    </div>
  </div>`;
}

async function renderDashboard() {
  const [dash, notifs] = await Promise.all([api('/api/dashboard'), api('/api/notifications?limit=1')]);
  navCounts.unread = notifs.unread || 0;

  const stat = (label, value, sub) => `<div class="panel"><div class="card-label">${label}</div><div class="stat-value">${num(value)}</div><div class="faint small">${sub || ''}</div></div>`;
  // §20 names this list "items requiring attention"; the API returns it under
  // that exact key. Reading the wrong one silently showed "nothing to do" even
  // while jobs were failing.
  const attention = dash.itemsRequiringAttention || [];
  const attentionText = {
    mailbox_not_connected: ['Connect a mailbox so outreach can be sent', 'settings', 'Connect mailbox'],
    automation_paused: ['Automation is paused — nothing will run until you resume', 'settings', 'Resume'],
    critical_notifications: ['Signals marked critical are waiting for you', 'notifications', 'Review'],
    failed_jobs: ['Jobs stopped and will not retry on their own', 'activity', 'Open activity'],
    follow_ups_due: ['Follow-ups are due and will go out on the next window', 'inbox', 'Open inbox'],
  };

  setView(`
    ${onboardingPanel(dash, attention)}
    <div class="grid cols-4" style="margin-bottom:16px">
      ${stat('Missions', dash.missions.total, `${num(dash.missions.active)} running on a schedule`)}
      ${stat('Prospects', dash.leads.discovered, `${num(dash.leads.sent)} contacted so far`)}
      ${stat('Messages sent', dash.messages.sent, `${num(dash.messages.generated)} written in total`)}
      ${stat('Replies', dash.conversations.replied, 'from businesses you wrote to')}
    </div>

    <div class="grid cols-4" style="margin-bottom:16px">
      ${stat('Websites analysed', dash.websitesAnalyzed, 'public pages read')}
      ${stat('Follow-ups scheduled', dash.conversations.followUpPending, `${num(dash.conversations.followUpsDue)} due now`)}
      ${stat('Unread signals', notifs.unread, 'in your signals feed')}
      ${stat('Jobs running', dash.jobs.running || 0, `${num(dash.jobs.queued || 0)} waiting`)}
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="panel pad-lg">
        <div class="section-head"><h2>Needs attention</h2>
          ${attention.length ? `<span class="badge ${attention.some((a) => a.kind === 'failed_jobs' || a.kind === 'mailbox_not_connected') ? 'red' : 'amber'}">${attention.length}</span>` : ''}
        </div>
        ${attention.length ? attention.map((a) => {
          const [text, link, cta] = attentionText[a.kind] || [titleCase(a.kind), 'dashboard', 'Open'];
          return `<div class="attention-row">
            <div><div class="small">${esc(text)}</div>
              ${a.count > 1 ? `<div class="faint small">${num(a.count)} in total</div>` : ''}</div>
            <button class="btn small" data-nav="${link}">${esc(cta)}</button>
          </div>`;
        }).join('') : '<div class="faint small">Nothing needs you right now. The fleet is cruising.</div>'}
      </div>
      <div class="panel pad-lg">
        <div class="section-head"><h2>Next scouting</h2></div>
        ${(dash.nextScouting || []).length ? dash.nextScouting.map((m) => `<div class="attention-row">
          <button class="btn small" data-nav="missions">${esc(m.name)}</button>
          <span class="small faint">${fmtRel(m.nextRunAt)}</span></div>`).join('') : '<div class="faint small">No active missions scheduled.</div>'}
      </div>
    </div>

    <div class="panel pad-lg">
      <div class="section-head"><h2>Job pipeline</h2>
        <span class="small faint">every stage the autonomous worker runs</span></div>
      <div class="pipeline">
        ${['queued', 'running', 'succeeded', 'failed'].map((k) => `<div class="pipeline-cell">
          <div class="card-label">${k}</div>
          <div class="stat-value sm">${num(dash.jobs[k] || 0)}</div></div>`).join('')}
      </div>
    </div>`);
}

// ============================================================
// MISSIONS
// ============================================================
/** Machine values never reach the reader: `review_send` is not a sentence. */
const SENDING_MODES = {
  scout_only: 'Scout only', review_send: 'Review & Send', autopilot: 'Autopilot',
};
const sendingModeLabel = (mode) => SENDING_MODES[mode] || titleCase(mode || 'not set');

const targetSummary = (locations) => {
  const list = (locations || []).map((l) => [l.city, l.country].filter(Boolean).join(', ')).filter(Boolean);
  if (!list.length) return 'No locations set';
  if (list.length <= 2) return `Targeting ${list.join(' and ')}`;
  return `Targeting ${list.slice(0, 2).join(', ')} and ${list.length - 2} more`;
};

async function renderMissions() {
  const { missions } = await api('/api/missions?includeArchived=1');
  const list = missions || [];
  setView(`
    <div class="spread" style="margin-bottom:16px">
      <div class="section-head" style="margin:0"><h2>${list.length} mission${list.length === 1 ? '' : 's'}</h2></div>
      <button class="btn" data-act="new-mission">＋ New mission</button>
    </div>
    ${list.length ? `<div class="grid cols-2">${list.map((m) => `
      <div class="panel">
        <div class="spread">
          <div><div style="font-weight:700;font-size:16px">${esc(m.name)}</div>
            <div class="faint small" style="margin-top:3px">${esc(titleCase(m.service || ''))} &middot; ${esc(sendingModeLabel(m.sendingMode))}</div></div>
          ${badge(m.status)}
        </div>
        <div class="row" style="gap:14px;margin-top:12px">
          <span class="small muted">${esc(targetSummary(m.locations))}</span>
        </div>
        <div class="row" style="gap:14px;margin-top:6px">
          <span class="small faint">${['scheduled', 'running'].includes(m.status)
    ? `Next run ${esc(fmtRel(m.nextRunAt))}` : 'Not on a schedule yet'}</span>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn small" data-nav="missions/${m.id}">Open</button>
        </div>
      </div>`).join('')}</div>`
      : `<div class="empty"><div class="big">No missions yet</div><div>Create your first mission to start prospecting.</div><div style="height:16px"></div><button class="btn" data-act="new-mission">＋ New mission</button></div>`}`);
}

async function renderMissionDetail(id) {
  const [{ mission: m }, activity, leadsRes] = await Promise.all([
    api(`/api/missions/${id}`), api(`/api/missions/${id}/activity`), api(`/api/leads?missionId=${id}`),
  ]);
  const actions = [];
  if (['scheduled', 'running'].includes(m.status)) { actions.push(['pause', 'Pause'], ['stop', 'Stop']); }
  if (['draft', 'paused', 'stopped', 'completed'].includes(m.status)) { actions.push(['activate', 'Activate']); }
  if (m.status === 'paused') actions.push(['resume', 'Resume']);
  actions.push(['run-now', 'Run now'], ['duplicate', 'Duplicate']);

  setView(`
    <div class="spread" style="margin-bottom:14px">
      <button class="btn small" data-nav="missions">← All missions</button>
      ${badge(m.status)}
    </div>
    <div class="panel pad-lg" style="margin-bottom:16px">
      <h2 class="display-md">${esc(m.name)}</h2>
      <div class="faint small" style="margin-top:4px">${esc(titleCase(m.service || ''))} · ${esc(sendingModeLabel(m.sendingMode))} · ${esc(m.timezone || 'UTC')}</div>
      <div class="row" style="gap:10px;margin-top:16px">
        <button class="btn primary" data-act="edit-mission" data-id="${id}">Edit mission</button>
        ${actions.map(([a, l]) => `<button class="btn" data-act="mission-action" data-id="${id}" data-action="${a}">${l}</button>`).join('')}
        <button class="btn danger" data-act="mission-delete" data-id="${id}" style="margin-left:auto">Archive</button>
      </div>
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="panel">
        <div class="section-head"><h2>Targets</h2></div>
        ${(m.locations || []).length ? m.locations.map((l) => `<div class="row spread" style="padding:6px 0;border-bottom:1px dashed var(--line)">
          <span>${esc([l.city, l.region, l.country].filter(Boolean).join(', '))}</span><span class="badge ${l.priority === 'high' ? 'amber' : 'faint'}">${esc(l.priority || 'medium')}</span></div>`).join('') : '<div class="faint small">No locations.</div>'}
      </div>
      <div class="panel">
        <div class="section-head"><h2>Windows</h2></div>
        ${(m.windows || []).length ? m.windows.map((w) => `<div class="row spread" style="padding:6px 0;border-bottom:1px dashed var(--line)">
          <span>${esc(dayName(w.dayOfWeek))}</span><span class="mono small">${esc(minutesToTime(w.startMin))}–${esc(minutesToTime(w.endMin))}</span></div>`).join('') : '<div class="faint small">No windows.</div>'}
      </div>
    </div>

    <div class="grid cols-3" style="margin-bottom:16px">
      <div class="panel"><div class="card-label">Prospects</div><div class="mono" style="font-size:22px">${num(leadsRes.total)}</div></div>
      <div class="panel"><div class="card-label">Last run</div><div class="mono" style="font-size:15px;margin-top:6px">${esc(m.lastRunAt ? fmtDate(m.lastRunAt) : 'never')}</div></div>
      <div class="panel"><div class="card-label">Next run</div><div class="mono" style="font-size:15px;margin-top:6px">${esc(m.nextRunAt ? fmtDate(m.nextRunAt) : '—')}</div></div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="section-head"><h2>Objective</h2></div>
      ${m.objectiveRaw ? `<p class="muted">${esc(m.objectiveRaw)}</p>` : ''}
      ${m.targetDescription ? `<p class="muted"><b>Target:</b> ${esc(m.targetDescription)}</p>` : ''}
      ${m.offerSummary ? `<p class="muted"><b>Offer:</b> ${esc(m.offerSummary)}</p>` : ''}
      ${m.investigationNotes ? `<p class="muted"><b>Investigation:</b> ${esc(m.investigationNotes)}</p>` : ''}
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="section-head"><h2>Recent prospects</h2></div>
      ${(leadsRes.leads || []).length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Business</th><th>Location</th><th>Status</th><th>Contact</th></tr></thead><tbody>
        ${leadsRes.leads.slice(0, 12).map((l) => `<tr class="row-click" data-nav="leads/${l.id}">
          <td>${esc(l.businessName)}</td><td class="muted">${esc([l.city, l.country].filter(Boolean).join(', '))}</td>
          <td>${badge(l.status)}</td><td class="small faint">${l.emailPublic ? esc(l.emailPublic) : l.phonePublic ? 'phone' : '—'}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="faint small">No prospects discovered yet.</div>'}
    </div>

    <div class="panel">
      <div class="section-head"><h2>Activity</h2></div>
      ${(activity.jobs || []).length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Stage</th><th>Status</th><th>When</th><th>Detail</th><th></th></tr></thead><tbody>
        ${activity.jobs.slice(0, 25).map((j) => {
          const fail = j.failure;
          const canRetry = j.status === 'failed' || j.status === 'waiting_retry';
          const retrySafe = !fail || fail.retrySafe !== false;
          const detail = fail
            ? `<b>${esc(fail.title || '')}</b><br><span class="muted">${esc(fail.detail || '')}</span><br><span class="faint">${esc(fail.action || '')}</span>`
            : esc((j.last_error || '').slice(0, 120));
          const action = canRetry
            ? (retrySafe
              ? `<button class="btn small" data-act="retry-job" data-id="${j.id}">Retry</button>`
              : '<span class="faint small">not retryable</span>')
            : '';
          return `<tr><td class="small">${esc(stageLabel(j.stage || j.kind || ''))}</td>
          <td>${badge(j.status)}</td>
          <td class="small muted">${fmtRel(j.finished_at || j.created_at || j.enqueued_at)}</td>
          <td class="small faint">${detail}</td>
          <td>${action}</td></tr>`;
        }).join('')}
        </tbody></table></div>` : '<div class="faint small">No job activity yet.</div>'}
    </div>`);
}

// ── mission create / edit modal ─────────────────────────────
function openMissionModal(prefill = {}, mode = 'new') {
  const m = prefill;
  const editing = mode === 'edit' && m.id;
  const locs = (m.locations && m.locations.length) ? m.locations : [{ country: '', city: '', priority: 'high' }];
  const wins = (m.windows && m.windows.length) ? m.windows : [{ dayOfWeek: 1, startMin: '09:00', endMin: '17:00' }];
  const title = editing ? 'Edit mission' : (mode === 'duplicate' ? 'Duplicate mission' : 'New mission');
  const submitLabel = editing ? 'Save changes' : (mode === 'duplicate' ? 'Create duplicate' : 'Create mission');
  const modal = openModal(`
    <form data-form="mission" data-mode="${editing ? 'edit' : mode}" data-mission-id="${editing ? m.id : ''}">
      <div class="spread" style="margin-bottom:14px">
        <h2 class="display-md">${title}</h2>
        <button type="button" class="btn small" data-act="close-modal">✕</button>
      </div>

      <div class="panel" style="margin-bottom:14px;background:rgba(124,156,255,.06)">
        <label class="card-label">Describe the mission in plain language</label>
        <textarea name="objective" rows="3" placeholder="Find restaurants in Austin with weak websites and offer a redesign." style="margin-top:8px">${esc(m.objectiveRaw || '')}</textarea>
        <div class="row" style="margin-top:8px">
          <button type="button" class="btn small" data-act="interpret">✦ Interpret with AI</button>
          <span class="faint small" id="interpret-note"></span>
        </div>
      </div>

      <label class="small muted">Mission name</label>
      <input name="name" required value="${esc(m.name || '')}" placeholder="Austin restaurants" />
      <div style="height:12px"></div>
      <label class="small muted">Objective summary</label>
      <input name="targetDescription" value="${esc(m.targetDescription || '')}" placeholder="restaurants with weak websites" />
      <div style="height:12px"></div>
      <label class="small muted">Offer</label>
      <input name="offerSummary" value="${esc(m.offerSummary || '')}" placeholder="A modern website that wins bookings" />
      <div style="height:12px"></div>
      <div class="grid cols-2">
        <div>
          <label class="small muted">Service</label>
          <select name="service">${['website_design', 'web_development', 'seo', 'marketing', 'branding', 'consulting', 'other'].map((s) => `<option value="${s}" ${m.service === s ? 'selected' : ''}>${titleCase(s)}</option>`).join('')}</select>
        </div>
        <div>
          <label class="small muted">Sending mode</label>
          <select name="sendingMode">
            ${[['scout_only', 'Scout only (no email)'], ['review_send', 'Review & send (I approve)'], ['autopilot', 'Autopilot (send automatically)']].map(([v, l]) => `<option value="${v}" ${(m.sendingMode || 'scout_only') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="section-head" style="margin-top:16px"><h2>Target locations</h2><button type="button" class="btn small" data-act="add-loc">+ Add</button></div>
      <div id="loc-list">${locs.map((l) => locRow(l)).join('')}</div>

      <div class="section-head" style="margin-top:16px"><h2>Send windows</h2><button type="button" class="btn small" data-act="add-win">+ Add</button></div>
      <div id="win-list">${wins.map((w) => winRow(w)).join('')}</div>

      <div class="section-head" style="margin-top:16px"><h2>Limits &amp; pacing</h2></div>
      <div class="grid cols-3">
        <div><label class="small muted">Follow-up delay (days)</label><input name="followUpDelayDays" type="number" min="0" value="${esc(m.followUpDelayDays ?? 2)}" /></div>
        <div><label class="small muted">Max follow-ups</label><input name="maxFollowUps" type="number" min="0" value="${esc(m.maxFollowUps ?? 3)}" /></div>
        <div><label class="small muted">Daily send limit</label><input name="dailySendLimit" type="number" min="1" value="${esc(m.dailySendLimit ?? 20)}" /></div>
      </div>
      <div class="grid cols-3" style="margin-top:10px">
        <div><label class="small muted">Hourly cap (0 = daily only)</label><input name="hourlySendLimit" type="number" min="0" value="${esc(m.hourlySendLimit ?? 0)}" /></div>
        <div><label class="small muted">Min seconds between sends</label><input name="minSecondsBetweenSends" type="number" min="0" value="${esc(m.minSecondsBetweenSends ?? 0)}" /></div>
        <div><label class="small muted">Max leads per run</label><input name="maxLeadsPerRun" type="number" min="1" value="${esc(m.maxLeadsPerRun ?? 25)}" /></div>
      </div>
      <div class="grid cols-2" style="margin-top:10px">
        <div><label class="small muted">Campaign start (optional)</label><input name="campaignStartAt" type="date" value="${esc((m.campaignStartAt || '').slice(0, 10))}" /></div>
        <div><label class="small muted">Campaign end (optional)</label><input name="campaignEndAt" type="date" value="${esc((m.campaignEndAt || '').slice(0, 10))}" /></div>
      </div>
      <div style="height:12px"></div>
      <label class="small muted">Outreach instructions (optional)</label>
      <textarea name="outreachInstructions" rows="2" placeholder="Tone, length, specifics to avoid.">${esc(m.outreachInstructions || '')}</textarea>

      <div class="row" style="margin-top:18px;justify-content:flex-end">
        <button type="button" class="btn" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">${submitLabel}</button>
      </div>
    </form>`);
  modal.querySelector('input[name="name"]').focus();
}

function locRow(l = {}) {
  return `<div class="row loc-row" style="margin-bottom:8px">
    <input class="loc-country" placeholder="Country (US)" value="${esc(l.country || '')}" style="max-width:120px" />
    <input class="loc-city" placeholder="City" value="${esc(l.city || '')}" />
    <select class="loc-priority" style="max-width:130px">${['high', 'medium', 'low'].map((p) => `<option value="${p}" ${(l.priority || 'high') === p ? 'selected' : ''}>${titleCase(p)}</option>`).join('')}</select>
    <button type="button" class="btn small" data-act="del-row">✕</button>
  </div>`;
}
function winRow(w = {}) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `<div class="row win-row" style="margin-bottom:8px">
    <select class="win-day" style="max-width:170px">${days.map((d, i) => `<option value="${i}" ${Number(w.dayOfWeek) === i ? 'selected' : ''}>${d}</option>`).join('')}</select>
    <input class="win-start" type="time" value="${esc(w.startMin || '09:00')}" />
    <input class="win-end" type="time" value="${esc(w.endMin || '17:00')}" />
    <button type="button" class="btn small" data-act="del-row">✕</button>
  </div>`;
}

function readMissionForm(form) {
  const fd = new FormData(form);
  const locations = [...form.querySelectorAll('.loc-row')].map((row) => ({
    country: row.querySelector('.loc-country').value.trim(),
    city: row.querySelector('.loc-city').value.trim() || null,
    priority: row.querySelector('.loc-priority').value,
  })).filter((l) => l.country);
  const windows = [...form.querySelectorAll('.win-row')].map((row) => ({
    dayOfWeek: Number(row.querySelector('.win-day').value),
    startMin: row.querySelector('.win-start').value,
    endMin: row.querySelector('.win-end').value,
  }));
  return {
    name: fd.get('name'), service: fd.get('service'), sendingMode: fd.get('sendingMode'),
    objectiveRaw: fd.get('objective') || null,
    targetDescription: fd.get('targetDescription') || null,
    offerSummary: fd.get('offerSummary') || null,
    outreachInstructions: fd.get('outreachInstructions') || null,
    followUpDelayDays: Number(fd.get('followUpDelayDays') || 2),
    maxFollowUps: Number(fd.get('maxFollowUps') || 3),
    dailySendLimit: Number(fd.get('dailySendLimit') || 20),
    hourlySendLimit: Number(fd.get('hourlySendLimit') || 0),
    minSecondsBetweenSends: Number(fd.get('minSecondsBetweenSends') || 0),
    maxLeadsPerRun: Number(fd.get('maxLeadsPerRun') || 25),
    campaignStartAt: fd.get('campaignStartAt') ? `${fd.get('campaignStartAt')} 00:00:00` : null,
    campaignEndAt: fd.get('campaignEndAt') ? `${fd.get('campaignEndAt')} 23:59:59` : null,
    locations, windows, timezone: state.user?.timezone || 'UTC',
  };
}

// ============================================================
// LEADS
// ============================================================
let leadFilters = { missionId: '', status: '', q: '' };
async function renderLeads() {
  const [leadsRes, missionsRes] = await Promise.all([
    api(`/api/leads${leadFilters.missionId ? `?missionId=${leadFilters.missionId}` : ''}`),
    api('/api/missions?includeArchived=1'),
  ]);
  navCounts.unread = navCounts.unread || 0;
  let rows = leadsRes.leads || [];
  if (leadFilters.status) rows = rows.filter((l) => l.status === leadFilters.status);
  if (leadFilters.q) {
    const q = leadFilters.q.toLowerCase();
    rows = rows.filter((l) => (l.businessName || '').toLowerCase().includes(q));
  }
  const statuses = ['discovered', 'investigated', 'analyzed', 'qualified', 'message_generated', 'awaiting_approval', 'sent', 'replied', 'suppressed', 'closed', 'failed'];

  setView(`
    <div class="spread" style="margin-bottom:14px">
      <div class="section-head" style="margin:0"><h2>${num(leadsRes.total)} prospects</h2></div>
      <div class="row" style="gap:8px">
        <input id="lead-q" placeholder="Search business…" value="${esc(leadFilters.q)}" style="max-width:220px" />
        <select id="lead-mission" style="max-width:220px">
          <option value="">All missions</option>
          ${(missionsRes.missions || []).map((m) => `<option value="${m.id}" ${String(leadFilters.missionId) === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
        </select>
        <select id="lead-status" style="max-width:180px">
          <option value="">All statuses</option>
          ${statuses.map((s) => `<option value="${s}" ${leadFilters.status === s ? 'selected' : ''}>${titleCase(s)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="panel">
      ${rows.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Business</th><th>Location</th><th>Status</th><th>Contact</th><th>Source</th></tr></thead><tbody>
        ${rows.map((l) => `<tr class="row-click" data-nav="leads/${l.id}">
          <td><b>${esc(l.businessName)}</b>${l.websiteUrl ? `<div class="faint small">${esc(l.websiteUrl)}</div>` : ''}</td>
          <td class="muted">${esc([l.city, l.region, l.country].filter(Boolean).join(', ') || '—')}</td>
          <td>${badge(l.status)}</td>
          <td class="small faint">${l.emailPublic ? esc(l.emailPublic) : l.phonePublic ? 'phone' : '—'}</td>
          <td class="small faint">${esc(l.discoverySource || '—')}</td></tr>`).join('')}
        </tbody></table></div>` : `<div class="empty"><div class="big">No prospects match</div><div>Run a mission to discover leads, or loosen the filters.</div></div>`}
    </div>`);

  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', fn); };
  bind('lead-q', (e) => { leadFilters.q = e.target.value; renderLeads(); });
  bind('lead-mission', (e) => { leadFilters.missionId = e.target.value; renderLeads(); });
  bind('lead-status', (e) => { leadFilters.status = e.target.value; renderLeads(); });
}

async function renderLeadDetail(id) {
  const data = await api(`/api/leads/${id}`);
  const l = data.lead;
  const lead = l;
  const suppression = data.suppression || {};
  const conversation = data.conversation || null;
  const followUps = data.followUps || [];
  setView(`
    <div class="spread" style="margin-bottom:14px">
      <button class="btn small" data-nav="leads">← All prospects</button>
      <div class="row">${badge(l.status)}${suppression.suppressed ? badge('suppressed', 'red') : ''}</div>
    </div>
    <div class="panel pad-lg" style="margin-bottom:16px">
      <h2 style="font-size:22px">${esc(l.businessName)}</h2>
      <div class="faint small" style="margin-top:4px">${esc([l.city, l.region, l.country].filter(Boolean).join(', ') || 'Unknown location')}${l.rating ? ` · ★ ${esc(l.rating)} (${num(l.reviewCount)})` : ''}</div>
      <div class="row" style="gap:10px;margin-top:14px">
        ${l.websiteUrl ? `<a class="btn small" href="${esc(l.websiteUrl)}" target="_blank" rel="noopener noreferrer">Visit website ↗</a>` : ''}
        ${l.emailPublic ? `<a class="btn small" href="mailto:${esc(l.emailPublic)}">${esc(l.emailPublic)}</a>` : ''}
        ${l.phonePublic ? `<a class="btn small" href="tel:${esc(l.phonePublic)}">${esc(l.phonePublic)}</a>` : ''}
      </div>
      ${suppression.suppressed ? `<div class="badge red" style="margin-top:12px">Suppressed · ${esc(suppression.scope || '')} · ${esc(suppression.reason || '')}</div>` : ''}
      ${l.stageError ? `<div class="badge red" style="margin-top:12px">Last error: ${esc(plainFailure(String(l.stageError).slice(0, 200)))}</div>` : ''}
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="panel">
        <div class="section-head"><h2>Website analysis</h2></div>
        ${data.websiteAnalysis ? `<div class="row" style="gap:18px;margin-bottom:10px">
          <div><div class="card-label">Quality</div><div class="stat-value sm">${data.websiteAnalysis.score != null ? num(data.websiteAnalysis.score) : '—'}</div></div>
          <div><div class="card-label">Status</div><div class="stat-value sm">${data.websiteAnalysis.ok ? 'Read' : 'Failed'}</div></div>
        </div>
        ${data.websiteAnalysis.error ? `<div class="badge red" style="margin-bottom:8px">${esc(plainFailure(String(data.websiteAnalysis.error).slice(0, 200)))}</div>` : ''}
        ${auditEnrichment(data.websiteAnalysis)}
        ${auditScreenshot(data.latestAudit)}
        ${findingsList(data.websiteAnalysis.findings)}`
          : '<div class="faint small">Not analysed yet.</div>'}
      </div>
      <div class="panel">
        <div class="section-head"><h2>Qualification</h2></div>
        ${data.qualification ? `<div class="row" style="gap:18px;margin-bottom:8px">
          <div><div class="card-label">Qualified</div><div class="stat-value sm">${data.qualification.qualified ? 'Yes' : 'No'}</div></div>
          <div><div class="card-label">Confidence</div><div class="stat-value sm">${data.qualification.confidence != null ? `${Math.round(Number(data.qualification.confidence) * 100)}%` : '—'}</div></div>
        </div>
        ${data.qualification.recommended_service ? `<div class="small" style="margin-top:4px"><span class="badge">${esc(String(data.qualification.recommended_service).replace(/_/g, ' '))}</span></div>` : ''}
        ${data.qualification.opportunity ? `<div class="small">${esc(data.qualification.opportunity)}</div>` : ''}
        <div class="small muted" style="margin-top:6px">${esc(data.qualification.reason || data.qualification.explanation || '')}</div>`
          : '<div class="faint small">Not qualified yet.</div>'}
      </div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="spread">
        <div class="section-head" style="margin:0"><h2>Conversation &amp; follow-ups</h2></div>
        ${conversation ? `<button class="btn small" data-nav="inbox/${conversation.id}">Open thread</button>` : ''}
      </div>
      ${conversation ? `
        <div class="row" style="gap:22px;margin-bottom:12px">
          <div><div class="card-label">Status</div><div style="margin-top:6px">${badge(conversation.status)}</div></div>
          <div><div class="card-label">Replies</div><div class="mono" style="font-size:20px">${num(conversation.reply_count)}</div></div>
          <div><div class="card-label">Last outbound</div><div class="small muted" style="padding-top:8px">${esc(conversation.last_outbound_at ? fmtRel(conversation.last_outbound_at) : '—')}</div></div>
          <div><div class="card-label">Last inbound</div><div class="small muted" style="padding-top:8px">${esc(conversation.last_inbound_at ? fmtRel(conversation.last_inbound_at) : '—')}</div></div>
        </div>
        ${suppression.suppressed
          ? `<div class="badge red">Not contactable · ${esc(suppression.scope || '')} · ${esc(suppression.reason || '')}</div>`
          : '<div class="badge green">Contactable</div>'}
        <div class="section-head" style="margin-top:16px"><h2>Follow-up schedule</h2></div>
        ${followUps.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>#</th><th>Due</th><th>Status</th><th>Note</th></tr></thead><tbody>
          ${followUps.map((f) => `<tr>
            <td class="mono small">${esc(f.sequence)}</td>
            <td class="small muted">${esc(fmtDate(f.due_at))} <span class="faint">(${esc(fmtRel(f.due_at))})</span></td>
            <td>${badge(f.status)}</td>
            <td class="small faint">${esc(f.reason_cancelled || '')}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="faint small">No follow-ups scheduled.</div>'}`
        : '<div class="faint small">No conversation yet — no outreach has been sent for this prospect.</div>'}
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="spread">
        <div class="section-head" style="margin:0"><h2>Ask about this prospect</h2></div>
        <div class="row" style="gap:8px">
          <button class="btn small" data-act="refresh-evidence" data-id="${lead.id}">Refresh evidence</button>
          <button class="btn small" data-act="draft-lead" data-id="${lead.id}">Draft outreach</button>
        </div>
      </div>
      <div class="row" style="gap:8px;margin-top:10px;align-items:flex-end">
        <textarea id="ask-question" rows="2" placeholder="e.g. What is the strongest reason to contact this business?"></textarea>
        <button class="btn small" data-act="ask" data-id="${lead.id}">Ask</button>
      </div>
      <div id="ask-answer" style="margin-top:10px"></div>
    </div>


    <div class="panel" style="margin-bottom:16px">
      <div class="section-head"><h2>Messages</h2></div>
      ${(data.messages || []).length ? data.messages.map((msg) => `
        <div class="panel ${msg.direction === 'inbound' ? 'bubble-in' : ''}" style="${msg.direction === 'inbound' ? '' : 'background:rgba(124,156,255,.04)'};margin-bottom:10px">
          <div class="spread"><b>${msg.direction === 'inbound' ? esc(msg.from_name || msg.from_address || 'Prospect') : esc(msg.subject)}</b>
            <div class="row">${badge(msg.direction === 'inbound' ? 'reply' : (msg.kind || 'message'))}${badge(msg.send_status || 'received')}</div></div>
          ${msg.direction === 'inbound' && msg.triage_summary ? `<div class="small teal" style="margin-top:6px">${esc(msg.triage_summary)}</div>` : ''}
          <div class="small muted" style="margin-top:8px;white-space:pre-wrap">${esc((msg.body_text || '').slice(0, 600))}</div>
          ${msg.error ? `<div class="badge red" style="margin-top:8px">${esc(plainFailure(String(msg.error).slice(0, 200)))}</div>` : ''}
          ${msg.direction !== 'inbound' && (msg.send_status === 'draft' || msg.send_status === 'awaiting_approval') ? `<div class="row" style="gap:8px;margin-top:10px">
            <button class="btn small" data-act="approve" data-id="${msg.id}">Approve &amp; send</button>
            <button class="btn small" data-act="reject" data-id="${msg.id}">Reject</button></div>` : ''}
          ${msg.failure ? `<div class="badge red" style="margin-top:10px">${esc(msg.failure.title || 'Failed')} · ${esc(msg.failure.detail || '')}</div>` : ''}
        </div>`).join('') : '<div class="faint small">No messages yet.</div>'}
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="section-head"><h2>Evidence history</h2></div>
      ${auditHistory(data.latestAudit)}
    </div>

    <div class="panel">
      <div class="section-head"><h2>Presence &amp; evidence</h2></div>
      ${data.presenceAnalysis ? presenceEvidence(data.presenceAnalysis) : '<div class="faint small">No presence signals recorded.</div>'}
    </div>`);
}

/**
 * Presence evidence, read as sentences rather than a JSON dump. The raw
 * payload is still available in the evidence history above.
 */
function presenceEvidence(analysis) {
  const rows = [];
  const push = (label, value) => { if (value !== null && value !== undefined && value !== '') rows.push([label, value]); };
  push('Opportunity score', analysis.opportunity_score != null ? `${analysis.opportunity_score} of 100` : null);
  push('Contact route found', analysis.contact_route_found ? 'Yes' : 'No');
  push('Contact route', analysis.contact_route || null);
  push('Contact evidence', analysis.contact_evidence || null);
  const findings = Array.isArray(analysis.findings) ? analysis.findings : [];
  const opportunities = Array.isArray(analysis.opportunities) ? analysis.opportunities : [];
  const list = (title, items) => (items.length ? `<div style="margin-top:10px">
      <div class="card-label">${title}</div>
      <ul class="plain-list">${items.map((f) => `<li>${esc(typeof f === 'string' ? f : `${f.issue || f.opportunity || ''}${f.severity ? ` (${esc(f.severity)})` : ''}`)}</li>`).join('')}</ul>
    </div>` : '');
  if (!rows.length && !findings.length && !opportunities.length) {
    return '<div class="faint small">Nothing recorded for this prospect yet.</div>';
  }
  return `${rows.length ? `<div class="table-wrap"><table class="table"><tbody>
      ${rows.map(([k, v]) => `<tr><td class="small muted" style="width:200px">${esc(k)}</td><td class="small">${esc(String(v))}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${list('What we found', findings)}
    ${list('What we can offer', opportunities)}`;
}

/** Renders the latest versioned audit and its captured evidence (spec §12/§30). */
function auditHistory(audit) {
  if (!audit) return '<div class="faint small">No evidence collected yet.</div>';
  const items = Array.isArray(audit.evidence) ? audit.evidence : [];
  const kindLabel = (k) => titleCase(String(k || '').replace(/_/g, ' '));
  return `<div class="row" style="gap:18px;margin-bottom:10px">
      <div><div class="card-label">Version</div><div class="stat-value sm">v${esc(audit.version)}</div></div>
      <div><div class="card-label">Status</div><div class="stat-value sm">${esc(titleCase(audit.status || 'unknown'))}</div></div>
      <div><div class="card-label">Trigger</div><div class="stat-value sm">${esc(stageLabel(audit.trigger || 'manual'))}</div></div>
      <div><div class="card-label">When</div><div class="small muted" style="padding-top:8px">${fmtRel(audit.finished_at || audit.started_at || audit.created_at)}</div></div>
    </div>
    ${audit.error ? `<div class="badge red" style="margin-bottom:8px">${esc(plainFailure(String(audit.error).slice(0, 200)))}</div>` : ''}
    ${items.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Evidence</th><th>Source</th><th>Recorded</th></tr></thead><tbody>
      ${items.map((e) => `<tr>
        <td><b class="small">${esc(kindLabel(e.kind))}</b>${e.url ? ` <a class="small faint" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">↗</a>` : ''}
          <div class="faint small mono" style="max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(evidenceSummary(e))}</div></td>
        <td class="small faint">${esc(e.method || e.source || '—')}</td>
        <td class="small muted">${fmtRel(e.created_at)}</td>
      </tr>`).join('')}
    </tbody></table></div>` : '<div class="faint small">No evidence items recorded for this version.</div>'}`;
}

/** A compact one-line summary of an evidence payload; images are summarised, not dumped. */
function evidenceSummary(e) {
  const p = e && e.payload;
  if (e && e.kind === 'screenshot' && p && p.dataUri) {
    const kb = Math.round((p.bytes || 0) / 1024);
    return `[rendered screenshot${kb ? ` · ${kb} KB` : ''}]`;
  }
  try { return JSON.stringify(p); } catch { return String(p); }
}

/**
 * §12 visual evidence — show the rendered screenshot the audit captured, when
 * one is present in the latest audit version. It is the real page as rendered,
 * not a reconstruction.
 */
function auditScreenshot(audit) {
  const items = audit && Array.isArray(audit.evidence) ? audit.evidence : [];
  const shot = items.find((e) => e.kind === 'screenshot' && e.payload && e.payload.dataUri);
  if (!shot) return '';
  const p = shot.payload;
  return `<div style="margin:10px 0">
    <div class="card-label">Rendered screenshot${p.width ? ` · ${esc(p.width)}×${esc(p.height)}` : ''}${p.strategy ? ` · ${esc(p.strategy)}` : ''}</div>
    <img src="${esc(p.dataUri)}" alt="Rendered screenshot of the website" loading="lazy" decoding="async"
      style="max-width:100%;border:1px solid rgba(124,156,255,.25);border-radius:10px;margin-top:6px" />
  </div>`;
}

/**
 * Renders the §12 enrichment evidence (rendered performance + link integrity)
 * captured for a website, when it is present. Everything shown is a recording
 * of what the audit measured, not an interpretation.
 */
function auditEnrichment(site) {
  const ev = site && site.evidence;
  if (!ev || typeof ev !== 'object') return '';
  const perf = ev.performance;
  const links = ev.linkIntegrity;
  if (!perf && !links) return '';
  const chips = [];
  if (perf) {
    if (perf.ok === false) {
      // A provider's own error text ("QUOTA EXCEEDED FOR QUOTA METRIC ...") is
      // noise to the reader; say what it means for them instead.
      const reason = {
        PAGESPEED_HTTP_ERROR: 'the public performance service is rate-limiting us right now',
        PAGESPEED_UNREACHABLE: 'the public performance service could not be reached',
        PAGESPEED_NO_RESULT: 'the public performance service returned no result for this site',
      }[perf.code] || 'the performance check did not complete';
      chips.push(`<div class="badge red" style="margin:4px 0">Performance not measured — ${esc(reason)}. The rest of the analysis is unaffected.</div>`);
    } else {
      const s = perf.scores || {};
      const chip = (label, value) => `<div><div class="card-label">${label}</div><div class="mono" style="font-size:18px">${value == null ? '—' : esc(value)}</div></div>`;
      chips.push(`<div class="row" style="gap:16px;margin:6px 0">${chip('Performance', s.performance)}${chip('Accessibility', s.accessibility)}${chip('SEO', s.seo)}</div>`);
      const v = perf.vitals || {};
      const vitals = [v.largestContentfulPaint && `LCP ${v.largestContentfulPaint}`, v.cumulativeLayoutShift && `CLS ${v.cumulativeLayoutShift}`, v.totalBlockingTime && `TBT ${v.totalBlockingTime}`].filter(Boolean);
      if (vitals.length) chips.push(`<div class="faint small">${esc(vitals.join(' · '))}${perf.hasRenderedScreenshot ? ' · rendered screenshot captured' : ''}</div>`);
    }
  }
  if (links) {
    const bad = Number(links.brokenCount || 0);
    chips.push(bad
      ? `<div class="badge red" style="margin-top:6px">${bad} broken same-origin link${bad === 1 ? '' : 's'} detected</div>`
      : `<div class="small muted" style="margin-top:6px">No broken links detected (${esc(links.checked || 0)} checked)</div>`);
  }
  return `<div style="margin:8px 0">${chips.join('')}</div>`;
}

/** Renders an analysis `findings` value, which may be an array or a summary object. */
function findingsList(findings) {
  if (!findings) return '';
  const items = Array.isArray(findings)
    ? findings
    : Array.isArray(findings.findings) ? findings.findings : null;
  if (items) {
    return `<ul class="small muted" style="margin:8px 0 0 16px">${items.map((f) => `<li>${esc(f.issue || f.name || String(f))}${f.evidence ? ` — <span class="faint">${esc(String(f.evidence).slice(0, 160))}</span>` : ''}</li>`).join('')}</ul>`;
  }
  return `<div class="faint small" style="margin-top:8px">${esc(JSON.stringify(findings).slice(0, 300))}</div>`;
}

// ============================================================
// INBOX (conversations)
// ============================================================
const inboxFilters = { status: '', q: '' };

/** Clamp a message body to a readable one-line preview. */
const preview = (text, max = 140) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
};

async function renderInbox() {
  const { conversations } = await api('/api/conversations');
  let rows = conversations || [];
  if (inboxFilters.status) rows = rows.filter((c) => c.status === inboxFilters.status);
  if (inboxFilters.q) {
    const q = inboxFilters.q.toLowerCase();
    rows = rows.filter((c) => `${c.business_name || ''} ${c.mission_name || ''} ${c.last_body || ''}`
      .toLowerCase().includes(q));
  }
  const groups = [
    { id: '', label: 'All' },
    { id: 'reply_received', label: 'Replied' },
    { id: 'sent', label: 'Sent' },
    { id: 'follow_up_scheduled', label: 'Follow-up scheduled' },
    { id: 'suppressed', label: 'Suppressed' },
  ].map((g) => ({ ...g, n: g.id ? rows.filter((c) => c.status === g.id).length : rows.length }));

  setView(`
    <div class="spread" style="margin-bottom:14px">
      <div class="section-head" style="margin:0"><h2>${num(rows.length)} thread${rows.length === 1 ? '' : 's'}</h2></div>
      <input id="inbox-q" placeholder="Search threads…" value="${esc(inboxFilters.q)}" style="max-width:240px" />
    </div>
    <div class="chips" style="margin-bottom:14px">
      ${groups.map((g) => `<button class="chip ${inboxFilters.status === g.id ? 'on' : ''}" data-act="inbox-filter" data-status="${g.id}">
        ${g.label} <span class="chip-n">${g.n}</span></button>`).join('')}
    </div>
    ${rows.length ? `<div class="stack">${rows.map((c) => {
    const inboundText = c.inbound_body || '';
    const where = [c.city, c.region, c.country].filter(Boolean).join(', ');
    const text = inboundText || c.last_body || '';
    return `
      <div class="panel row-click thread-row" data-nav="inbox/${c.id}">
        <div class="thread-main">
          <div class="spread" style="align-items:baseline">
            <b>${esc(c.business_name || `Thread #${c.id}`)}</b>
            <span class="faint small">${fmtRel(c.inbound_at || c.updated_at || c.created_at)}</span>
          </div>
          <div class="row small faint" style="gap:8px;margin-top:2px">
            ${c.mission_name ? `<span>${esc(c.mission_name)}</span>` : ''}
            ${where ? `<span>&middot; ${esc(where)}</span>` : ''}
            ${c.reply_count ? `<span>&middot; ${c.reply_count} repl${c.reply_count === 1 ? 'y' : 'ies'}</span>` : ''}
          </div>
          <div class="small muted thread-preview">${inboundText ? '<b class="teal">Replied:</b> ' : ''}${esc(preview(text)) || '<span class="faint">No message yet</span>'}</div>
        </div>
        <div class="row thread-side">${badge(c.status)}</div>
      </div>`;
  }).join('')}</div>`
      : `<div class="empty"><div class="big">No threads match</div><div>Outreach threads appear here once a mission sends its first message.</div></div>`}`);

  const box = document.getElementById('inbox-q');
  if (box) box.addEventListener('input', (e) => { inboxFilters.q = e.target.value; renderInbox(); });
}

async function renderConversation(id) {
  const data = await api(`/api/conversations/${id}`);
  const c = data.conversation; const msgs = data.messages || []; const lead = data.lead;
  setView(`
    <div class="spread" style="margin-bottom:14px">
      <button class="btn small" data-nav="inbox">← Inbox</button>
      <div class="row">${badge(c.status)}${lead ? `<button class="btn small" data-nav="leads/${lead.id}">${esc(lead.businessName)}</button>` : ''}</div>
    </div>
    <div class="panel pad-lg">
      <div class="section-head"><h2>Thread</h2>
        <span class="small faint">${msgs.filter((m) => m.direction === 'inbound').length} in
          &middot; ${msgs.filter((m) => m.direction !== 'inbound').length} out</span></div>
      ${msgs.length ? `<div class="stack">${msgs.map((m) => `
        <div class="panel ${m.direction === 'inbound' ? 'bubble-in' : ''}" style="${m.direction === 'inbound' ? '' : 'background:rgba(124,156,255,.04)'}">
          <div class="spread">
            <b>${m.direction === 'inbound' ? esc(m.from_name || m.from_address || 'Prospect') : esc(m.subject || 'Message')}</b>
            <div class="row">${badge(m.direction === 'inbound' ? 'reply' : (m.kind || 'message'))}${badge(m.send_status || 'received')}</div>
          </div>
          ${m.direction === 'inbound' && m.triage_summary
    ? `<div class="small teal" style="margin-top:6px">Read as ${esc(titleCase(m.intent || 'a reply'))}: ${esc(m.triage_summary)}</div>` : ''}
          <div class="small muted" style="margin-top:8px;white-space:pre-wrap">${esc(m.body_text || '')}</div>
          <div class="faint small" style="margin-top:8px">${esc(fmtDate(m.received_at || m.sent_at || m.created_at))}</div>
          ${m.direction !== 'inbound' && (m.send_status === 'draft' || m.send_status === 'awaiting_approval') ? `<div class="row" style="gap:8px;margin-top:10px">
            <button class="btn small" data-act="approve" data-id="${m.id}">Approve &amp; send</button>
            <button class="btn small" data-act="reject" data-id="${m.id}">Reject</button></div>` : ''}
        </div>`).join('')}</div>` : '<div class="faint small">No messages.</div>'}
    </div>`);
}

// ============================================================
// NOTIFICATIONS
// ============================================================
async function renderNotifications() {
  const { notifications, unread } = await api('/api/notifications');
  navCounts.unread = unread || 0;
  const list = notifications || [];
  setView(`
    <div class="spread" style="margin-bottom:14px">
      <div class="section-head" style="margin:0"><h2>${num(unread)} unread</h2></div>
      <button class="btn small" data-act="read-all">Mark all read</button>
    </div>
    ${list.length ? `<div class="stack">${list.map((n) => `
      <div class="panel" style="${n.read_at ? '' : 'border-color:var(--line-strong)'}">
        <div class="spread">
          <div class="row">${badge(n.severity, n.severity === 'critical' ? 'red' : n.severity === 'warning' ? 'amber' : 'cyan')}<b>${esc(n.title)}</b></div>
          <span class="faint small">${fmtRel(n.created_at)}</span>
        </div>
        ${n.body ? `<div class="small muted" style="margin-top:6px">${esc(n.body)}</div>` : ''}
        <div class="row" style="margin-top:8px">
          ${!n.read_at ? `<button class="btn small" data-act="read-notif" data-id="${n.id}">Mark read</button>` : ''}
          ${n.missionId ? `<button class="btn small" data-nav="missions/${n.missionId}">Mission</button>` : ''}
          ${n.leadId ? `<button class="btn small" data-nav="leads/${n.leadId}">Lead</button>` : ''}
        </div>
      </div>`).join('')}</div>`
      : `<div class="empty"><div class="big">No signals</div><div>You will be notified here when something needs attention.</div></div>`}`);
}

// ============================================================
// ACTIVITY  (§36 detailed activity, §37)
// ============================================================
// One autonomous run produces dozens of identical rows, so the list is grouped
// by mission and collapsed by default. What matters at a glance is whether
// anything is stuck, so failures stay expanded and everything else folds away.
const activityFilters = { missionId: '', only: '' };
const ACTIVITY_ROWS = 12;
let activityVisible = ACTIVITY_ROWS;

async function renderActivity() {
  const [{ jobs, stats, audit }, { missions }] = await Promise.all([
    api('/api/activity'), api('/api/missions?includeArchived=1'),
  ]);
  const list = jobs || [];
  const s = stats || {};
  const names = new Map((missions || []).map((m) => [m.id, m.name]));

  let rows = list;
  if (activityFilters.missionId) rows = rows.filter((j) => String(j.mission_id) === String(activityFilters.missionId));
  if (activityFilters.only === 'failed') rows = rows.filter((j) => j.status === 'failed');
  if (activityFilters.only === 'live') rows = rows.filter((j) => ['queued', 'running'].includes(j.status));
  if (activityFilters.only !== 'failed' && activityVisible > rows.length) activityVisible = ACTIVITY_ROWS;

  const failed = rows.filter((j) => j.status === 'failed');
  const others = rows.filter((j) => j.status !== 'failed');
  const visible = others.slice(0, activityVisible);

  setView(`
    <div class="spread" style="margin-bottom:14px">
      <div class="section-head" style="margin:0"><h2>Activity</h2></div>
      <div class="row">${badge(`running ${num(s.running || 0)}`, (s.running ? 'green' : 'faint'))}
        ${badge(`queued ${num(s.queued || 0)}`, 'faint')}
        ${badge(`failed ${num(s.failed || 0)}`, (s.failed ? 'red' : 'faint'))}</div>
    </div>
    <div class="chips" style="margin-bottom:14px">
      <button class="chip ${!activityFilters.only ? 'on' : ''}" data-act="activity-filter" data-only="" data-mission="${activityFilters.missionId}">Everything <span class="chip-n">${rows.length}</span></button>
      <button class="chip ${activityFilters.only === 'failed' ? 'on' : ''}" data-act="activity-filter" data-only="failed" data-mission="${activityFilters.missionId}">Needs attention <span class="chip-n">${rows.filter((j) => j.status === 'failed').length}</span></button>
      <button class="chip ${activityFilters.only === 'live' ? 'on' : ''}" data-act="activity-filter" data-only="live" data-mission="${activityFilters.missionId}">In flight</button>
    </div>
    ${rows.length ? `
      ${failed.length ? `<div class="panel" style="margin-bottom:14px;border-color:rgb(226,86,86,.35)">
        <div class="spread" style="padding:14px 16px;border-bottom:1px solid var(--line)">
          <b>${failed.length} job${failed.length === 1 ? '' : 's'} stopped and will not retry on their own</b>
          <span class="small faint">${esc(failed[0].failure?.title || 'Needs your attention')}</span>
        </div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Stage</th><th>Mission</th><th>What happened</th><th>When</th><th></th></tr></thead>
          <tbody>${failed.map((j) => `<tr>
            <td>${badge(stageLabel(j.stage), toneOf(j.stage))}</td>
            <td class="small">${missionCell(j, names)}</td>
            <td><div class="small">${esc(j.failure?.title || 'The job failed.')}</div>
                <div class="small faint">${esc(j.failure?.detail || '')}</div></td>
            <td class="small faint">${fmtRel(j.updated_at)}</td>
            <td><button class="btn small" data-act="retry-job" data-id="${j.id}">Retry</button></td>
          </tr>`).join('')}</tbody></table></div>
      </div>` : ''}
      <div class="panel">
        <div class="spread" style="padding:14px 16px;border-bottom:1px solid var(--line)">
          <b>Completed work</b>
          <select id="activity-mission" style="max-width:240px">
            <option value="">All missions</option>
            ${(missions || []).map((m) => `<option value="${m.id}" ${String(activityFilters.missionId) === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          </select>
        </div>
        ${visible.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Stage</th><th>Mission</th><th>State</th><th>Attempts</th><th>Updated</th></tr></thead>
          <tbody>${visible.map((j) => `<tr>
            <td>${badge(stageLabel(j.stage), toneOf(j.stage))}</td>
            <td class="small">${missionCell(j, names)}</td>
            <td>${badge(j.status)}</td>
            <td class="small">${num(j.attempts)}/${num(j.max_attempts)}</td>
            <td class="small faint">${fmtRel(j.updated_at)}</td>
          </tr>`).join('')}</tbody></table></div>
          ${others.length > activityVisible ? `<div style="padding:12px 16px;border-top:1px solid var(--line)">
            <button class="btn small" data-act="activity-more">Show ${Math.min(50, others.length - activityVisible)} more of ${num(others.length)}</button>
          </div>` : ''}`
          : '<div class="empty"><div class="big">Nothing completed yet</div><div>Finished work appears here.</div></div>'}
      </div>`
      : `<div class="empty"><div class="big">No activity matches</div><div>Jobs appear here the moment the autonomous worker starts them.</div></div>`}
    ${(audit || []).length ? `<details class="panel pad-lg" style="margin-top:14px">
      <summary style="cursor:pointer"><b>Audit trail</b> <span class="faint small">${num(audit.length)} recorded events</span></summary>
      <div class="table-wrap" style="margin-top:12px"><table class="table">
        <thead><tr><th>When</th><th>Action</th><th>Entity</th><th>By</th></tr></thead>
        <tbody>${audit.map((a) => `<tr>
          <td class="small faint">${fmtRel(a.at)}</td>
          <td class="small">${esc(a.action)}</td>
          <td class="small muted">${esc(a.entity_type || '')}${a.entity_id != null ? ` #${a.entity_id}` : ''}</td>
          <td class="small faint">${esc(a.actor || '')}</td>
        </tr>`).join('')}</tbody></table></div></details>` : ''}`);

  const sel = document.getElementById('activity-mission');
  if (sel) sel.addEventListener('change', (e) => { activityFilters.missionId = e.target.value; renderActivity(); });
}

function missionCell(job, names) {
  if (!job.mission_id) return '<span class="faint small">system</span>';
  const name = names.get(job.mission_id);
  return name
    ? `<button class="btn small" data-nav="missions/${job.mission_id}">${esc(name)}</button>`
    : `<button class="btn small" data-nav="missions/${job.mission_id}">Mission #${job.mission_id}</button>`;
}

// ============================================================
// EMAIL  (§6 mailbox, §18 reply monitoring, §37)
// ============================================================
async function renderEmail() {
  const [{ providers }, { conversations }, dash] = await Promise.all([
    api('/api/email/connections'), api('/api/conversations'), api('/api/dashboard'),
  ]);
  const list = providers || [];
  const connected = list.filter((p) => p.connection?.status === 'connected');
  const threads = conversations || [];
  setView(`
    <div class="spread" style="margin-bottom:14px">
      <div class="section-head" style="margin:0"><h2>Email</h2></div>
      <button class="btn small" data-nav="settings">Provider settings</button>
    </div>
    <div class="panel pad-lg">
      <div class="card-label">Sending and monitoring</div>
      <div class="row" style="gap:18px;margin-top:8px">
        <div><div class="small muted">Mailboxes</div><div class="big">${num(connected.length)}</div></div>
        <div><div class="small muted">Conversations</div><div class="big">${num(threads.length)}</div></div>
        <div><div class="small muted">Messages sent</div><div class="big">${num(dash.messages?.sent || 0)}</div></div>
        <div><div class="small muted">Replies received</div><div class="big">${num(dash.conversations?.replied || 0)}</div></div>
      </div>
      ${list.length ? `<div class="stack" style="margin-top:16px">${list.map((p) => `
        <div class="panel">
          <div class="spread">
            <div><b>${esc(p.label || p.id)}</b>
              <div class="small muted">${p.authType === 'api_key' ? 'API key' : 'Authorization redirect'}${p.capabilities?.replies ? ' · can read replies' : ''}</div></div>
            <div class="row">${badge(p.connection?.status || 'disconnected', p.connection?.status === 'connected' ? 'green' : 'faint')}
              ${p.connection?.status === 'connected' ? `<button class="btn small" data-act="email-disconnect" data-provider="${esc(p.id)}">Disconnect</button>` : ''}</div>
          </div>
          ${p.connection?.accountEmail ? `<div class="small faint" style="margin-top:8px">${esc(p.connection.accountEmail)}</div>` : ''}
        </div>`).join('')}</div>`
      : `<div class="empty"><div class="big">No mailbox connected</div><div>Nexora sends through your own account. Connect one to let the autopilot reach prospects.</div>
          <div style="margin-top:14px"><button class="btn" data-nav="settings">Connect a mailbox</button></div></div>`}
    </div>
    <div class="panel pad-lg" style="margin-top:14px">
      <div class="card-label">Reply monitoring</div>
      <div class="small muted" style="margin-top:6px">Connected mailboxes are polled every 15 minutes; a reply stops the follow-up sequence immediately.</div>
      <div class="stack" style="margin-top:12px">
        ${threads.length ? threads.slice(0, 10).map((c) => `
          <div class="panel row-click" data-nav="inbox/${c.id}">
            <div class="spread"><b>Thread #${c.id}</b>${badge(c.status)}</div>
            <div class="small faint" style="margin-top:6px">${num(c.reply_count)} repl${c.reply_count === 1 ? 'y' : 'ies'} · updated ${fmtRel(c.updated_at || c.created_at)}</div>
          </div>`).join('')
        : '<div class="faint small">No conversations yet.</div>'}
      </div>
    </div>`);
}

// ============================================================
// SETTINGS
// ============================================================
/**
 * §23/§26 — render the automation driver's real state so the operator can see
 * the worker is actually running, rather than trusting a route exists.
 */
function automationStatus(a) {
  if (!a) return '';
  const q = a.queue || {};
  let detail = null;
  try { detail = a.lastRun?.detail ? JSON.parse(a.lastRun.detail) : null; } catch { detail = null; }
  const lastWhen = a.lastRun?.at ? fmtRel(a.lastRun.at) : null;
  const rows = [
    ['Cron secret', a.cron?.configured ? 'configured' : 'not set'],
    ['Request auto-tick', a.cron?.autoTick ? 'on' : 'off'],
    ['Last automation run', lastWhen ? `${lastWhen}${detail?.drained != null ? ` · ${esc(String(detail.drained))} jobs drained` : ''}` : 'never'],
    ['Queue', `queued ${num(q.queued || 0)} · running ${num(q.running || 0)} · retry ${num(q.waiting_retry || 0)} · failed ${num(q.failed || 0)}`],
    ['Running missions', num(a.runningMissions || 0)],
    ['Mailbox', a.connectedMailbox ? `connected (${esc((a.connectedProviders || []).join(', '))})` : 'not connected'],
    ['Worker', esc(a.worker?.workerId || '—')],
  ];
  return `<div style="margin-top:16px">
    <div class="card-label">Automation status</div>
    <table class="table" style="margin-top:6px"><tbody>
      ${rows.map(([k, v]) => `<tr><td class="small muted" style="width:44%">${k}</td><td class="small">${v}</td></tr>`).join('')}
    </tbody></table>
  </div>`;
}

async function renderSettings() {
  const [ai, diag, email, suppressions, automation] = await Promise.all([
    api('/api/ai/settings'), api('/api/ai/diagnostics'),
    api('/api/email/connections'), api('/api/suppressions'),
    api('/api/automation/status').catch(() => null),
  ]);
  state.email = email.providers || [];
  const sel = ai.selection || {};
  const catalog = ai.catalog || [];
  const providers = ai.providers || [];
  const paused = Boolean(state.user?.automationPaused);

  const connected = (p) => (p.connection || {}).status === 'connected';

  // A provider card renders differently per provider: OAuth offers a redirect,
  // API-key providers (Resend) render their own fields. Capabilities are shown
  // honestly so no provider is advertised as something it is not.
  const fieldRow = (f) => `
    <div style="margin-top:8px">
      <label class="small muted">${esc(f.label)}</label>
      <input name="${esc(f.name)}" type="${esc(f.type || 'text')}" ${f.required ? 'required' : ''}
             autocomplete="${f.secret ? 'new-password' : 'off'}" placeholder="${esc(f.placeholder || '')}">
      ${f.help ? `<div class="faint small" style="margin-top:4px">${esc(f.help)}</div>` : ''}
    </div>`;
  const providerCard = (p) => {
    const cap = p.capabilities || {};
    const conn = p.connection || {};
    const isApiKey = p.authType === 'api_key';
    const capabilityTag = (on, label) => badge(label, on ? 'green' : 'faint');
    return `
    <div class="panel" style="border:1px solid rgba(255,255,255,.09)">
      <div class="spread">
        <b>${esc(p.label || p.id)}</b>
        ${connected(p) ? badge('connected', 'green') : badge('not connected', 'faint')}
      </div>
      ${p.whatItDoes ? `<p class="small muted" style="margin-top:8px">${esc(p.whatItDoes)}</p>` : ''}
      <div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">
        ${capabilityTag(cap.send, 'Sends')}
        ${capabilityTag(cap.replies, cap.replies ? 'Reads replies' : 'No replies')}
        ${capabilityTag(cap.domainVerification, 'Domains')}
        ${badge(isApiKey ? 'API key' : 'OAuth', 'faint')}
      </div>
      ${connected(p) ? `
        <div style="margin-top:12px">
          <div class="small"><b>${esc(conn.accountEmail || '')}</b></div>
          ${conn.statusDetail ? `<div class="small" style="margin-top:4px;color:#f5b74e">${esc(conn.statusDetail)}</div>` : ''}
          <div class="row" style="margin-top:10px">
            <button class="btn small" data-act="email-disconnect" data-provider="${esc(p.id)}">Disconnect</button>
            ${p.docsUrl ? `<a class="btn small" href="${esc(p.docsUrl)}" target="_blank" rel="noopener">Docs</a>` : ''}
          </div>
        </div>` : isApiKey ? `
        <form data-form="email-connect-key" data-provider="${esc(p.id)}" style="margin-top:12px">
          ${(p.fields || []).map(fieldRow).join('')}
          ${(p.requirements || []).length ? `<details style="margin-top:10px"><summary class="small muted">What you need</summary><ul class="small faint" style="margin:8px 0 0 18px">${p.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}
          <button class="btn small" type="submit" style="margin-top:12px">Connect ${esc(p.label || p.id)}</button>
        </form>` : `
        <div style="margin-top:12px">
          ${p.configured
            ? `<button class="btn small" data-act="email-connect" data-provider="${esc(p.id)}">Connect with ${esc(p.label || p.id)}</button>`
            : `<div class="small faint">Not configured on this deployment. Set its client credentials in the environment to enable it.</div>`}
        </div>`}
      ${(p.notes || []).length ? `<div class="faint small" style="margin-top:10px">${p.notes.map((n) => esc(n)).join(' ')}</div>` : ''}
    </div>`;
  };

  setView(`
    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="panel">
        <div class="section-head"><h2>Profile</h2></div>
        <form data-form="profile">
          <label class="small muted">Full name</label>
          <input name="fullName" value="${esc(state.user?.fullName || '')}" required />
          <div style="height:12px"></div>
          <label class="small muted">Timezone</label>
          <input name="timezone" value="${esc(state.user?.timezone || 'UTC')}" placeholder="UTC" />
          <div style="height:14px"></div>
          <button class="btn" type="submit">Save profile</button>
        </form>
      </div>

      <div class="panel">
        <div class="section-head"><h2>Automation</h2></div>
        <p class="small muted">Pausing stops every mission from enqueuing new work. In-flight jobs finish safely.</p>
        <div class="row" style="margin-top:12px">
          <button class="btn" data-act="toggle-pause">${paused ? '▶ Resume automation' : '⏸ Pause all automation'}</button>
          <span class="badge ${paused ? 'amber' : 'green'}">${paused ? 'Paused' : 'Running'}</span>
        </div>
        ${automationStatus(automation)}
        <div class="section-head" style="margin-top:20px"><h2>Recovery code</h2></div>
        <p class="small muted">Generate a fresh one-time recovery code. Existing codes are burned.</p>
        <button class="btn" data-act="gen-recovery" style="margin-top:10px">Generate new code</button>
        <div id="recovery-box"></div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="section-head"><h2>AI model (OpenCode)</h2>
        <button class="btn small" data-act="refresh-catalog" style="margin-left:auto">↻ Refresh catalog</button></div>
      <div class="row" style="gap:16px;margin-bottom:12px">
        <span class="badge ${diag.ok ? 'green' : 'amber'}">${diag.ok ? 'Reachable' : 'Not reachable'}</span>
        <span class="small faint">${esc(diag.version || diag.error || '')} · transport: ${esc(diag.transport || 'cli')}</span>
      </div>
      <div class="grid cols-2">
        <div>
          <label class="small muted">Provider</label>
          <select id="ai-provider">${providers.map((p) => `<option ${sel.provider === p ? 'selected' : ''}>${esc(p)}</option>`).join('') || `<option>${esc(sel.provider || '')}</option>`}</select>
        </div>
        <div>
          <label class="small muted">Model</label>
          <select id="ai-model">${catalog.filter((m) => m.provider === sel.provider).map((m) => `<option value="${esc(m.id)}" ${sel.model === m.id ? 'selected' : ''}>${esc(m.name || m.id)}</option>`).join('') || `<option value="${esc(sel.model || '')}">${esc(sel.model || '')}</option>`}</select>
        </div>
      </div>
      <button class="btn" data-act="save-model" style="margin-top:12px">Save model</button>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="section-head"><h2>Email connections</h2></div>
      <p class="small muted">Connect one or more sending accounts. Nexora sends through the connected account and records every message. Providers differ — read each card before connecting.</p>
      <div class="grid cols-2" style="margin-top:12px">
        ${state.email.length ? state.email.map(providerCard).join('') : '<div class="faint small">No email providers available.</div>'}
      </div>
    </div>

    <div class="panel">
      <div class="section-head"><h2>Suppressions</h2></div>
      <form data-form="suppression" class="row" style="gap:8px">
        <select name="scope" style="max-width:130px">${['email', 'domain'].map((s) => `<option>${s}</option>`).join('')}</select>
        <input name="value" placeholder="name@example.com or example.com" required />
        <button class="btn small" type="submit">Add</button>
      </form>
      <div style="margin-top:14px">
        ${(suppressions.suppressions || []).length ? (suppressions.suppressions || []).map((s) => `
          <div class="spread" style="padding:8px 0;border-bottom:1px dashed var(--line)">
            <span><span class="badge faint">${esc(s.scope)}</span> <span class="mono small">${esc(s.value)}</span></div>
            <div class="row"><span class="faint small">${esc(s.reason || '')}</span>
            <button class="btn small" data-act="suppression-del" data-id="${s.id}">Remove</button></div>
          </div>`).join('') : '<div class="faint small">No suppressions.</div>'}
    </div>`);

  document.getElementById('ai-provider')?.addEventListener('change', (e) => {
    const provider = e.target.value;
    const modelSelect = document.getElementById('ai-model');
    const models = catalog.filter((m) => m.provider === provider);
    modelSelect.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join('') || `<option value="${esc(sel.model || '')}">${esc(sel.model || '')}</option>`;
  });
}

// ============================================================
// ACTIONS
// ============================================================
async function runAction(act, el) {
  try {
    switch (act) {
      case 'logout': {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        state.user = null; state.csrf = null; authTab = 'login'; location.hash = ''; render(); return;
      }
      case 'open-nav': state.navOpen = true; render(); return;
      case 'close-nav': state.navOpen = false; render(); return;
      case 'refresh': await render(); return;
      case 'auth-tab': authTab = el.dataset.tab; renderAuth(); return;

      case 'new-mission': openMissionModal({}); return;
      case 'close-modal': closeModal(); return;
      case 'add-loc': {
        const form = el.closest('form');
        form.querySelector('#loc-list').insertAdjacentHTML('beforeend', locRow({}));
        return;
      }
      case 'add-win': {
        const form = el.closest('form');
        form.querySelector('#win-list').insertAdjacentHTML('beforeend', winRow({}));
        return;
      }
      case 'del-row': el.closest('.loc-row, .win-row')?.remove(); return;

      case 'interpret': return interpretMission(el);

      case 'edit-mission': {
        const { mission } = await api(`/api/missions/${el.dataset.id}`);
        openMissionModal(mission, 'edit');
        return;
      }
      case 'mission-action': {
        const id = el.dataset.id; const action = el.dataset.action;
        const map = { activate: 'activate', pause: 'pause', resume: 'resume', stop: 'stop', 'run-now': 'run-now', duplicate: 'duplicate' };
        const endpoint = map[action];
        const res = await api(`/api/missions/${id}/${endpoint}`, { method: 'POST', body: {} });
        if (action === 'duplicate' && res.mission) { toast('Mission duplicated', 'ok'); go(`missions/${res.mission.id}`); return; }
        if (action === 'run-now') toast(`Queued ${res.enqueued ?? 0} discovery job(s)`, 'ok');
        else toast(`Mission ${action}d`, 'ok');
        render(); return;
      }
      case 'mission-delete': {
        if (!confirm('Archive this mission? It stops running and is hidden from the active list, but its prospects are kept.')) return;
        await api(`/api/missions/${el.dataset.id}`, { method: 'DELETE' });
        toast('Mission archived', 'ok'); go('missions'); return;
      }
      case 'approve': await api(`/api/messages/${el.dataset.id}/approve`, { method: 'POST', body: {} }); toast('Message approved and queued', 'ok'); render(); return;
      case 'reject': await api(`/api/messages/${el.dataset.id}/reject`, { method: 'POST', body: {} }); toast('Message rejected', 'ok'); render(); return;

      case 'ask': {
        const id = el.dataset.id;
        const question = document.getElementById('ask-question')?.value?.trim();
        const out = document.getElementById('ask-answer');
        if (!question) { toast('Type a question first.', 'err'); return; }
        if (out) out.innerHTML = '<div class="faint small">Reading the recorded evidence…</div>';
        el.disabled = true;
        try {
          const r = await api(`/api/leads/${id}/ask`, { method: 'POST', body: { question } });
          if (out) out.innerHTML = `<div class="small" style="white-space:pre-wrap">${esc(r.answer)}</div>${(r.observed || []).length ? `<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:8px">${r.observed.map((o) => `<span class="badge faint">${esc(o)}</span>`).join('')}</div>` : ''}`;
        } catch (e) {
          if (out) out.innerHTML = `<div class="small" style="color:var(--red)">${esc(e.message)}</div>`;
        } finally { el.disabled = false; }
        return;
      }
      case 'draft-lead': {
        el.disabled = true;
        try {
          await api(`/api/leads/${el.dataset.id}/draft`, { method: 'POST', body: {} });
          toast('Draft created — review it below', 'ok'); render();
        } finally { el.disabled = false; }
        return;
      }
      case 'refresh-evidence': {
        el.disabled = true;
        try { await api(`/api/leads/${el.dataset.id}/refresh`, { method: 'POST', body: {} }); toast('Evidence refresh queued', 'ok'); }
        finally { el.disabled = false; }
        return;
      }
      case 'retry-job': {
        el.disabled = true;
        try { await api(`/api/jobs/${el.dataset.id}/retry`, { method: 'POST', body: {} }); toast('Job re-queued', 'ok'); render(); }
        finally { el.disabled = false; }
        return;
      }
      case 'read-notif': await api(`/api/notifications/${el.dataset.id}/read`, { method: 'POST', body: {} }); render(); return;
      case 'inbox-filter': inboxFilters.status = el.dataset.status || ''; renderInbox(); return;
      case 'activity-filter': activityFilters.only = el.dataset.only || ''; activityFilters.missionId = el.dataset.mission || ''; renderActivity(); return;
      case 'activity-more': activityVisible += 38; renderActivity(); return;
      case 'toggle-pause': {
        const paused = Boolean(state.user?.automationPaused);
        const r = await api('/api/auth/automation-paused', { method: 'POST', body: { paused: !paused } });
        state.user = r.user || state.user;
        toast(!paused ? 'Automation paused' : 'Automation resumed', 'ok'); render(); return;
      }
      case 'gen-recovery': {
        const r = await api('/api/auth/recovery-code', { method: 'POST', body: {} });
        document.getElementById('recovery-box').innerHTML = `<div class="panel" style="margin-top:12px;background:rgba(124,156,255,.06)"><div class="card-label">One-time recovery code</div><div class="mono" style="margin-top:6px;user-select:all">${esc(r.recoveryCode || r.code || '')}</div></div>`;
        return;
      }
      case 'refresh-catalog': { await api('/api/ai/settings?refresh=1'); toast('Catalog refreshed', 'ok'); renderSettings(); return; }
      case 'save-model': {
        const model = document.getElementById('ai-model')?.value;
        const provider = document.getElementById('ai-provider')?.value;
        await api('/api/ai/settings', { method: 'PUT', body: { model, provider, agent: null } });
        toast('Model saved', 'ok'); return;
      }
      case 'email-connect': {
        const provider = el.dataset.provider;
        const r = await api(`/api/email/${provider}/connect`, { method: 'POST', body: {} });
        if (r.authorizeUrl) { toast('Redirecting to provider…', 'ok'); location.href = r.authorizeUrl; }
        else toast(r.error || 'No authorize URL returned', 'err');
        return;
      }
      case 'email-disconnect': {
        if (!confirm('Disconnect this mailbox? Outreach will stop sending.')) return;
        await api(`/api/email/${el.dataset.provider}/disconnect`, { method: 'POST', body: {} });
        toast('Mailbox disconnected', 'ok'); render(); return;
      }
      default: return;
    }
  } catch (e) {
    toast(e.message || 'Action failed', 'err', 'Error');
  }
}

async function interpretMission(el) {
  const form = el.closest('form');
  const note = form.querySelector('#interpret-note');
  const objective = form.querySelector('textarea[name="objective"]')?.value?.trim();
  if (!objective || objective.length < 10) { toast('Describe the mission in a little more detail.', 'err'); return; }
  el.disabled = true; note.textContent = 'Interpreting…';
  try {
    const r = await api('/api/missions/interpret', { method: 'POST', body: { objective } });
    const it = r.interpretation || {};
    if (it.name && !form.querySelector('input[name="name"]').value) form.querySelector('input[name="name"]').value = it.name;
    if (it.service) form.querySelector('select[name="service"]').value = it.service;
    if (it.target_description) form.querySelector('input[name="targetDescription"]').value = it.target_description;
    if (it.offer_summary) form.querySelector('input[name="offerSummary"]').value = it.offer_summary;
    if (Array.isArray(it.countries)) {
      const list = form.querySelector('#loc-list');
      list.innerHTML = '';
      for (const country of it.countries) list.insertAdjacentHTML('beforeend', locRow({ country, priority: 'high' }));
    }
    note.textContent = `Interpreted with ${esc(it.model || 'the model')}. Review before creating.`;
  } catch (e) {
    note.textContent = '';
    toast(e.code === 'AI_NOT_CONFIGURED' ? 'Connect an AI model in Control to use interpretation.' : e.message, 'err', 'Interpret failed');
  } finally {
    el.disabled = false;
  }
}

async function runForm(name, form) {
  try {
    if (name === 'login') {
      const fd = new FormData(form);
      const r = await api('/api/auth/login', { method: 'POST', body: { username: fd.get('username'), securityAnswer: fd.get('securityAnswer') } });
      await afterAuth(r.user); return;
    }
    if (name === 'signup') {
      const fd = new FormData(form);
      const r = await api('/api/auth/signup', {
        method: 'POST',
        body: {
          fullName: fd.get('fullName'), username: fd.get('username'),
          securityQuestion: fd.get('securityQuestion'), securityAnswer: fd.get('securityAnswer'),
        },
      });
      closeModal();
      if (r.recoveryCode) {
        modalRoot.innerHTML = '';
        alert(`Save your recovery code — it is shown only once:\n\n${r.recoveryCode}`);
      }
      await afterAuth(r.user); return;
    }
    if (name === 'recover') {
      const fd = new FormData(form);
      const r = await api('/api/auth/recover', {
        method: 'POST',
        body: { username: fd.get('username'), recoveryCode: fd.get('recoveryCode'), newSecurityAnswer: fd.get('newSecurityAnswer') },
      });
      await afterAuth(r.user); return;
    }
    if (name === 'profile') {
      const fd = new FormData(form);
      const r = await api('/api/auth/profile', { method: 'PATCH', body: { fullName: fd.get('fullName'), timezone: fd.get('timezone') } });
      state.user = r.user || state.user;
      toast('Profile saved', 'ok'); render(); return;
    }
    if (name === 'email-connect-key') {
      const provider = form.dataset.provider;
      const fd = new FormData(form);
      const body = {};
      for (const [k, v] of fd.entries()) body[k] = v;
      const r = await api(`/api/email/${provider}/connect-key`, { method: 'POST', body });
      const c = r.connection || {};
      toast(c.senderReady === false ? 'Connected — verify your sending domain before sending.' : 'Email account connected', 'ok');
      renderSettings(); return;
    }
    if (name === 'mission') {
      const body = readMissionForm(form);
      if (!body.name) { toast('A mission name is required.', 'err'); return; }
      if (!body.locations.length) { toast('Add at least one target location.', 'err'); return; }
      const missionId = form.dataset.missionId;
      if (form.dataset.mode === 'edit' && missionId) {
        await api(`/api/missions/${missionId}`, { method: 'PATCH', body });
        closeModal();
        toast('Mission updated', 'ok');
        go(`missions/${missionId}`); return;
      }
      const r = await api('/api/missions', { method: 'POST', body });
      closeModal();
      toast('Mission created', 'ok');
      go(`missions/${r.mission.id}`); return;
    }
    if (name === 'suppression') {
      const fd = new FormData(form);
      await api('/api/suppressions', { method: 'POST', body: { scope: fd.get('scope'), value: fd.get('value') } });
      toast('Suppression added', 'ok'); renderSettings(); return;
    }
  } catch (e) {
    toast(e.message || 'Submission failed', 'err', 'Error');
  }
}

// ── delegated events ────────────────────────────────────────
document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { e.preventDefault(); go(nav.dataset.nav); return; }
  const btn = e.target.closest('[data-act]');
  if (btn) { e.preventDefault(); runAction(btn.dataset.act, btn); return; }
});
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  runForm(form.dataset.form, form);
});

// ============================================================
// BOOT
// ============================================================
/** Fade the pre-render splash out once the first real frame is ready. */
function hideSplash() {
  const el = document.getElementById('splash');
  if (!el) return;
  const done = () => el.remove();
  el.classList.add('hide');
  el.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 900);
}

async function boot() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user; state.csrf = me.csrfToken; state.email = me.email || [];
  } catch { state.user = null; }
  if (!location.hash) location.hash = '#/dashboard';
  await render();
  hideSplash();
}
boot();