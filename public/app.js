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
const NAV = [
  { id: 'dashboard', label: 'Command', icon: '◉' },
  { id: 'missions', label: 'Missions', icon: '✦' },
  { id: 'leads', label: 'Prospects', icon: '⌖' },
  { id: 'inbox', label: 'Inbox', icon: '✉' },
  { id: 'notifications', label: 'Signals', icon: '⚑', count: 'unread' },
  { id: 'settings', label: 'Control', icon: '⚙' },
];
const navCounts = { unread: 0 };

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
            <span class="ico">${n.icon}</span>${n.label}
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
          <div class="title">${titleCase(r.path)}</div>
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
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-head">
          <img class="brand-logo" src="/favicon.svg" alt="" />
          <h1>NEXORA OUTREACH</h1>
          <div class="faint small" style="letter-spacing:.2em">AUTONOMOUS PROSPECTING CONSOLE</div>
        </div>
        <div class="tabs">${tabs.map(([id, l]) => `<button class="${authTab === id ? 'on' : ''}" data-act="auth-tab" data-tab="${id}">${l}</button>`).join('')}</div>
        <div class="panel pad-lg">${forms[authTab] || forms.login}</div>
      </div>
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
async function renderDashboard() {
  const [dash, notifs] = await Promise.all([api('/api/dashboard'), api('/api/notifications?limit=1')]);
  navCounts.unread = notifs.unread || 0;

  const stat = (label, value, sub) => `<div class="panel"><div class="card-label">${label}</div><div style="font:700 30px var(--mono);margin:8px 0 2px">${num(value)}</div><div class="faint small">${sub || ''}</div></div>`;
  const attention = dash.attention || [];
  const attentionText = {
    mailbox_not_connected: ['Connect a mailbox', 'settings'],
    automation_paused: ['Automation is paused — resume in Control', 'settings'],
    critical_notifications: ['Critical signals need review', 'notifications'],
    failed_jobs: ['Some jobs failed and need a retry', 'dashboard'],
    follow_ups_due: ['Follow-ups are due', 'inbox'],
  };

  setView(`
    <div class="grid cols-4" style="margin-bottom:18px">
      ${stat('Missions', dash.missions.total, `${num(dash.missions.active)} active`)}
      ${stat('Prospects', dash.leads.discovered, `${num(dash.leads.qualified)} qualified`)}
      ${stat('Messages', dash.messages.generated, `${num(dash.messages.sent)} sent`)}
      ${stat('Replies', dash.conversations.replied, 'conversations')}
    </div>

    <div class="grid cols-3" style="margin-bottom:18px">
      ${stat('Websites analysed', dash.websitesAnalyzed, '')}
      ${stat('Follow-ups due', dash.conversations.followUpsDue, `${num(dash.conversations.followUpPending)} pending`)}
      ${stat('Unread signals', notifs.unread, '')}
    </div>

    <div class="grid cols-2" style="margin-bottom:18px">
      <div class="panel">
        <div class="section-head"><h2>Needs attention</h2></div>
        ${attention.length ? attention.map((a) => {
          const [text, link] = attentionText[a.kind] || [titleCase(a.kind), 'dashboard'];
          return `<div class="row spread" style="padding:8px 0;border-bottom:1px dashed var(--line)">
            <span>${esc(text)}</span>
            <button class="btn small" data-nav="${link}">${num(a.count)} →</button></div>`;
        }).join('') : '<div class="faint small">Nothing needs you right now. The fleet is cruising.</div>'}
      </div>
      <div class="panel">
        <div class="section-head"><h2>Next scouting</h2></div>
        ${(dash.nextScouting || []).length ? dash.nextScouting.map((m) => `<div class="row spread" style="padding:8px 0;border-bottom:1px dashed var(--line)">
          <button class="btn small" data-nav="missions">${esc(m.name)}</button>
          <span class="mono small faint">${fmtRel(m.nextRunAt)}</span></div>`).join('') : '<div class="faint small">No active missions scheduled.</div>'}
      </div>
    </div>

    <div class="panel">
      <div class="section-head"><h2>Job pipeline</h2></div>
      <div class="row" style="gap:22px">
        ${['queued', 'running', 'succeeded', 'failed'].map((k) => `<div>
          <div class="card-label">${k}</div>
          <div class="mono" style="font-size:20px">${num(dash.jobs[k] || 0)}</div></div>`).join('')}
      </div>
    </div>`);
}

// ============================================================
// MISSIONS
// ============================================================
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
            <div class="faint small" style="margin-top:3px">${esc(titleCase(m.service || ''))} · ${esc(m.sendingMode || '')}</div></div>
          ${badge(m.status)}
        </div>
        <div class="row" style="gap:14px;margin-top:12px">
          <span class="small muted">${m.locations?.length || 0} target${(m.locations?.length || 0) === 1 ? '' : 's'}</span>
          <span class="small muted">Next: ${esc(m.nextRunAt ? fmtRel(m.nextRunAt) : '—')}</span>
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
      <h2 style="font-size:22px">${esc(m.name)}</h2>
      <div class="faint small" style="margin-top:4px">${esc(titleCase(m.service || ''))} · ${esc(m.sendingMode || '')} · ${esc(m.timezone || 'UTC')}</div>
      <div class="row" style="gap:10px;margin-top:16px">
        ${actions.map(([a, l]) => `<button class="btn" data-act="mission-action" data-id="${id}" data-action="${a}">${l}</button>`).join('')}
        <button class="btn" data-act="mission-delete" data-id="${id}" style="margin-left:auto;border-color:rgba(255,107,129,.4);color:var(--red)">Delete</button>
      </div>
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="panel">
        <div class="section-head"><h2>Targets</h2></div>
        ${(m.locations || []).length ? m.locations.map((l) => `<div class="row spread" style="padding:6px 0;border-bottom:1px dashed var(--line)">
          <span>${esc([l.city, l.region, l.country].filter(Boolean).join(', '))}</span><span class="badge faint">${esc(l.priority || 'normal')}</span></div>`).join('') : '<div class="faint small">No locations.</div>'}
      </div>
      <div class="panel">
        <div class="section-head"><h2>Windows</h2></div>
        ${(m.windows || []).length ? m.windows.map((w) => `<div class="row spread" style="padding:6px 0;border-bottom:1px dashed var(--line)">
          <span>${esc(dayName(w.dayOfWeek))}</span><span class="mono small">${esc(w.startMin)}–${esc(w.endMin)}</span></div>`).join('') : '<div class="faint small">No windows.</div>'}
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
        <thead><tr><th>Stage</th><th>Status</th><th>When</th><th>Detail</th></tr></thead><tbody>
        ${activity.jobs.slice(0, 25).map((j) => `<tr><td class="mono small">${esc(j.stage || j.kind || '')}</td>
          <td>${badge(j.status)}</td><td class="small muted">${fmtRel(j.finished_at || j.created_at || j.enqueued_at)}</td>
          <td class="small faint">${esc((j.last_error || '').slice(0, 120))}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="faint small">No job activity yet.</div>'}
    </div>`);
}

// ── mission creation modal ──────────────────────────────────
function openMissionModal(prefill = {}) {
  const m = prefill;
  const locs = m.locations || [{ country: '', city: '', priority: 'high' }];
  const wins = m.windows || [{ dayOfWeek: 1, startMin: '09:00', endMin: '17:00' }];
  const modal = openModal(`
    <form data-form="mission">
      <div class="spread" style="margin-bottom:14px">
        <h2 style="font-size:18px">${m.id ? 'Duplicate mission' : 'New mission'}</h2>
        <button type="button" class="btn small" data-act="close-modal">✕</button>
      </div>

      <div class="panel" style="margin-bottom:14px;background:rgba(56,230,255,.06)">
        <label class="card-label">Describe the mission in plain language</label>
        <textarea name="objective" rows="3" placeholder="Find restaurants in Austin with weak websites and offer a redesign." style="margin-top:8px"></textarea>
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
            ${[['scout_only', 'Scout only (no email)'], ['review', 'Review & send (I approve)'], ['autopilot', 'Autopilot (send automatically)']].map(([v, l]) => `<option value="${v}" ${(m.sendingMode || 'scout_only') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="section-head" style="margin-top:16px"><h2>Target locations</h2><button type="button" class="btn small" data-act="add-loc">+ Add</button></div>
      <div id="loc-list">${locs.map((l) => locRow(l)).join('')}</div>

      <div class="section-head" style="margin-top:16px"><h2>Send windows</h2><button type="button" class="btn small" data-act="add-win">+ Add</button></div>
      <div id="win-list">${wins.map((w) => winRow(w)).join('')}</div>

      <div class="section-head" style="margin-top:16px"><h2>Limits</h2></div>
      <div class="grid cols-3">
        <div><label class="small muted">Follow-up delay (days)</label><input name="followUpDelayDays" type="number" min="0" value="${esc(m.followUpDelayDays ?? 2)}" /></div>
        <div><label class="small muted">Max follow-ups</label><input name="maxFollowUps" type="number" min="0" value="${esc(m.maxFollowUps ?? 3)}" /></div>
        <div><label class="small muted">Daily send limit</label><input name="dailySendLimit" type="number" min="1" value="${esc(m.dailySendLimit ?? 20)}" /></div>
      </div>
      <div style="height:12px"></div>
      <label class="small muted">Outreach instructions (optional)</label>
      <textarea name="outreachInstructions" rows="2" placeholder="Tone, length, specifics to avoid.">${esc(m.outreachInstructions || '')}</textarea>

      <div class="row" style="margin-top:18px;justify-content:flex-end">
        <button type="button" class="btn" data-act="close-modal">Cancel</button>
        <button class="btn" type="submit" style="background:linear-gradient(90deg,var(--cyan),var(--violet));color:#04040f;font-weight:700">${m.id ? 'Create duplicate' : 'Create mission'}</button>
      </div>
    </form>`);
  modal.querySelector('input[name="name"]').focus();
}

function locRow(l = {}) {
  return `<div class="row loc-row" style="margin-bottom:8px">
    <input class="loc-country" placeholder="Country (US)" value="${esc(l.country || '')}" style="max-width:120px" />
    <input class="loc-city" placeholder="City" value="${esc(l.city || '')}" />
    <select class="loc-priority" style="max-width:130px">${['high', 'normal', 'low'].map((p) => `<option value="${p}" ${(l.priority || 'high') === p ? 'selected' : ''}>${titleCase(p)}</option>`).join('')}</select>
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
  const suppression = data.suppression || {};
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
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="panel">
        <div class="section-head"><h2>Website analysis</h2></div>
        ${data.websiteAnalysis ? `<div class="row" style="gap:18px;margin-bottom:10px">
          <div><div class="card-label">Quality</div><div class="mono" style="font-size:22px">${esc(data.websiteAnalysis.quality_score ?? '—')}</div></div>
          <div><div class="card-label">Has site</div><div class="mono" style="font-size:22px">${data.websiteAnalysis.has_website ? 'yes' : 'no'}</div></div>
        </div>
        ${Array.isArray(data.websiteAnalysis.opportunities) ? `<div class="row" style="gap:6px;flex-wrap:wrap">${data.websiteAnalysis.opportunities.map((o) => `<span class="badge faint">${esc(o)}</span>`).join('')}</div>` : ''}`
          : '<div class="faint small">Not analysed yet.</div>'}
      </div>
      <div class="panel">
        <div class="section-head"><h2>Qualification</h2></div>
        ${data.qualification ? `<div class="mono" style="font-size:22px">${esc(data.qualification.score ?? '—')}</div>
          <div class="small muted" style="margin-top:6px">${esc(data.qualification.rationale || data.qualification.reason || '')}</div>`
          : '<div class="faint small">Not qualified yet.</div>'}
      </div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="section-head"><h2>Messages</h2></div>
      ${(data.messages || []).length ? data.messages.map((msg) => `
        <div class="panel" style="background:rgba(56,230,255,.04);margin-bottom:10px">
          <div class="spread"><b>${esc(msg.subject)}</b>${badge(msg.send_status)}</div>
          <div class="small muted" style="margin-top:8px;white-space:pre-wrap">${esc((msg.body_text || '').slice(0, 600))}</div>
          ${msg.send_status === 'draft' || msg.send_status === 'awaiting_approval' ? `<div class="row" style="gap:8px;margin-top:10px">
            <button class="btn small" data-act="approve" data-id="${msg.id}">Approve & send</button>
            <button class="btn small" data-act="reject" data-id="${msg.id}">Reject</button></div>` : ''}
        </div>`).join('') : '<div class="faint small">No messages yet.</div>'}
    </div>

    <div class="panel">
      <div class="section-head"><h2>Presence & evidence</h2></div>
      ${data.presenceAnalysis ? `<div class="small muted" style="white-space:pre-wrap">${esc(JSON.stringify(data.presenceAnalysis, null, 2).slice(0, 1200))}</div>` : '<div class="faint small">No presence signals recorded.</div>'}
    </div>`);
}

// ============================================================
// INBOX (conversations)
// ============================================================
async function renderInbox() {
  const { conversations } = await api('/api/conversations');
  const list = conversations || [];
  setView(`
    <div class="section-head"><h2>${list.length} conversation${list.length === 1 ? '' : 's'}</h2></div>
    ${list.length ? `<div class="stack">${list.map((c) => `
      <div class="panel row-click" data-nav="inbox/${c.id}">
        <div class="spread">
          <div><b>Conversation #${c.id}</b> <span class="faint small">· lead ${c.lead_id}</span></div>
          <div class="row">${badge(c.status)}</div>
        </div>
        <div class="row" style="gap:16px;margin-top:8px">
          <span class="small muted">Outbound: ${num(c.last_outbound_at ? 1 : 0)}</span>
          <span class="small muted">Replies: ${num(c.reply_count)}</span>
          <span class="small faint">Updated ${fmtRel(c.updated_at || c.created_at)}</span>
        </div>
      </div>`).join('')}</div>`
      : `<div class="empty"><div class="big">Inbox empty</div><div>Outreach threads appear here once messages are generated.</div></div>`}`);
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
      <div class="section-head"><h2>Thread</h2></div>
      ${msgs.length ? `<div class="stack">${msgs.map((m) => `
        <div class="panel" style="background:rgba(56,230,255,.04)">
          <div class="spread"><b>${esc(m.subject)}</b><div class="row">${badge(m.kind || 'message')}${badge(m.send_status)}</div></div>
          <div class="small muted" style="margin-top:8px;white-space:pre-wrap">${esc(m.body_text || '')}</div>
          <div class="faint small" style="margin-top:8px">${esc(fmtDate(m.sent_at || m.created_at))}</div>
          ${m.send_status === 'draft' || m.send_status === 'awaiting_approval' ? `<div class="row" style="gap:8px;margin-top:10px">
            <button class="btn small" data-act="approve" data-id="${m.id}">Approve & send</button>
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
// SETTINGS
// ============================================================
async function renderSettings() {
  const [ai, diag, email, suppressions] = await Promise.all([
    api('/api/ai/settings'), api('/api/ai/diagnostics'),
    api('/api/email/connections'), api('/api/suppressions'),
  ]);
  state.email = email.providers || [];
  const sel = ai.selection || {};
  const catalog = ai.catalog || [];
  const providers = ai.providers || [];
  const paused = Boolean(state.user?.automationPaused);

  const connected = (p) => p.connection?.status === 'connected';

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
      ${state.email.length ? state.email.map((p) => `
        <div class="spread" style="padding:10px 0;border-bottom:1px dashed var(--line)">
          <div class="row">${badge(connected(p) ? 'connected' : 'not connected', connected(p) ? 'green' : 'faint')}<b>${esc(p.provider)}</b>${p.connection?.account_email ? `<span class="faint small">${esc(p.connection.account_email)}</span>` : ''}</div>
          ${connected(p) ? `<button class="btn small" data-act="email-disconnect" data-provider="${esc(p.provider)}">Disconnect</button>`
            : `<button class="btn small" data-act="email-connect" data-provider="${esc(p.provider)}">Connect</button>`}
        </div>`).join('') : '<div class="faint small">No email providers configured. Set the OAuth credentials in the environment.</div>'}
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
        if (!confirm('Delete this mission and all of its prospects? This cannot be undone.')) return;
        await api(`/api/missions/${el.dataset.id}`, { method: 'DELETE' });
        toast('Mission deleted', 'ok'); go('missions'); return;
      }
      case 'approve': await api(`/api/messages/${el.dataset.id}/approve`, { method: 'POST', body: {} }); toast('Message approved and queued', 'ok'); render(); return;
      case 'reject': await api(`/api/messages/${el.dataset.id}/reject`, { method: 'POST', body: {} }); toast('Message rejected', 'ok'); render(); return;
      case 'read-notif': await api(`/api/notifications/${el.dataset.id}/read`, { method: 'POST', body: {} }); render(); return;
      case 'toggle-pause': {
        const paused = Boolean(state.user?.automationPaused);
        const r = await api('/api/auth/automation-paused', { method: 'POST', body: { paused: !paused } });
        state.user = r.user || state.user;
        toast(!paused ? 'Automation paused' : 'Automation resumed', 'ok'); render(); return;
      }
      case 'gen-recovery': {
        const r = await api('/api/auth/recovery-code', { method: 'POST', body: {} });
        document.getElementById('recovery-box').innerHTML = `<div class="panel" style="margin-top:12px;background:rgba(56,230,255,.06)"><div class="card-label">One-time recovery code</div><div class="mono" style="margin-top:6px;user-select:all">${esc(r.recoveryCode || r.code || '')}</div></div>`;
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
        toast('Mailbox disconnected', 'ok'); renderSettings(); return;
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
    if (name === 'mission') {
      const body = readMissionForm(form);
      if (!body.name) { toast('A mission name is required.', 'err'); return; }
      if (!body.locations.length) { toast('Add at least one target location.', 'err'); return; }
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
async function boot() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user; state.csrf = me.csrfToken; state.email = me.email || [];
  } catch { state.user = null; }
  if (!location.hash) location.hash = '#/dashboard';
  render();
}
boot();