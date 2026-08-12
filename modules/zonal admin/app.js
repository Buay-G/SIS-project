/* This file relies on i18n.js being loaded first (t, applyTranslations,
   getCurrentLang, window.setLang) — see index.html script order.

   All data now comes from the real backend (see server.js's
   /api/zonal/* routes) instead of the old data.js mock arrays — that
   file has been removed. Auth is the httpOnly `auth_token` cookie set
   at login, so every fetch() below just needs credentials: 'include';
   there's no token to manage client-side.

   Change API_BASE if this page is ever served from a different
   origin than the API (e.g. a separate frontend host/port) — same-
   origin (the default, '') needs no CORS setup at all. Cross-origin
   would also require the backend's CORS config to allow credentials
   for this specific origin, since browsers won't send cookies on a
   cross-origin fetch otherwise. */
const API_BASE = '';

// Status values coming back from the DB should be lowercase ('pending',
// 'approved', 'rejected', 'accepted', 'declined') per every backend query
// and the documented schema — but some existing rows/environments have
// been seen returning uppercase values instead (e.g. 'PENDING'), which
// silently breaks every exact-match comparison below (a pending proposal
// vanishes from the Approvals queue, an untranslated i18n key like
// 'za_act_status_PENDING' shows up raw in the UI). Route every status
// comparison and every za_act_status_/za_incoming_status_ key lookup
// through this so casing in the data can never break the UI again.
function normStatus(s){ return String(s == null ? '' : s).trim().toLowerCase(); }

// If the session cookie is missing/expired, every one of these calls
// gets a 401 from requireAuth — bounce straight back to login instead
// of leaving the caller to render a raw "Request failed (401)" panel.
// guard.js already does this check once on page load; this catches it
// again for any call made later in a session that expires mid-visit.
function handleUnauthorized() {
    window.location.href = '/login.html';
}

async function apiGet(path, params) {
    let url = API_BASE + path;
    if (params) {
        const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
        const s = qs.toString();
        if (s) url += '?' + s;
    }
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) { handleUnauthorized(); throw new Error('Not logged in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

async function apiPost(path, body) {
    return apiSend('POST', path, body);
}

async function apiPut(path, body) {
    return apiSend('PUT', path, body);
}

async function apiDelete(path) {
    return apiSend('DELETE', path);
}

async function apiSend(method, path, body) {
    const res = await fetch(API_BASE + path, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    if (res.status === 401) { handleUnauthorized(); throw new Error('Not logged in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

/* ---------------------------------------------------------------
   Styled confirm dialog — replaces the browser's native confirm(),
   which can't be themed and looks jarring against the rest of the
   UI. Returns a Promise<boolean> resolved true/false depending on
   which button was pressed (or false if dismissed via backdrop/Esc).
   Styling lives in styles.css under .confirm-modal-*.
   --------------------------------------------------------------- */
function showConfirm(message, { title, confirmText } = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="confirm-modal" role="alertdialog" aria-modal="true">
        <div class="confirm-modal-icon"><i data-lucide="alert-triangle"></i></div>
        <h3 class="confirm-modal-title">${title || t('za_confirm_title')}</h3>
        <p class="confirm-modal-msg">${message}</p>
        <div class="confirm-modal-actions">
          <button class="btn ghost" id="confirmModalCancel">${t('za_cancel')}</button>
          <button class="btn primary" id="confirmModalOk">${confirmText || t('za_confirm_yes')}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    if (window.lucide) lucide.createIcons();

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKey);

    backdrop.addEventListener('click', e => { if (e.target === backdrop) finish(false); });
    backdrop.querySelector('#confirmModalCancel').addEventListener('click', () => finish(false));
    backdrop.querySelector('#confirmModalOk').addEventListener('click', () => finish(true));
    backdrop.querySelector('#confirmModalOk').focus();
  });
}

/* ---------------------------------------------------------------
   Credentials modal — shown once, right after a push creates a login
   (currently just the Supervisor account created via an approved
   assign_supervisor proposal — see the push-proposal handler below).
   The push response's `message` already contains the ID/password in
   prose, but that text scrolls past in a small inline hint under the
   table; this puts it front and center so it isn't missed before the
   admin navigates away, with a copy button since it'll usually be
   typed into a message to the new Supervisor rather than written down
   by hand. Styling lives in styles.css under .creds-modal-*.
   --------------------------------------------------------------- */
function showCredentialsModal(id, password){
  const backdrop = document.createElement('div');
  backdrop.className = 'confirm-modal-backdrop';
  backdrop.innerHTML = `
    <div class="confirm-modal creds-modal" role="alertdialog" aria-modal="true">
      <div class="confirm-modal-icon"><i data-lucide="key-round"></i></div>
      <h3 class="confirm-modal-title">${t('za_creds_modal_title')}</h3>
      <p class="confirm-modal-msg">${t('za_creds_modal_hint')}</p>
      <div class="creds-row"><span class="creds-label">${t('za_identity_id_label')}</span><span class="creds-value" id="credsIdVal">${id}</span></div>
      <div class="creds-row"><span class="creds-label">${t('za_f_password')}</span><span class="creds-value" id="credsPwVal">${password}</span></div>
      <div class="confirm-modal-actions">
        <button class="btn ghost" id="credsCopyBtn">${t('za_creds_copy')}</button>
        <button class="btn primary" id="credsCloseBtn">${t('za_confirm_yes')}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (window.lucide) lucide.createIcons();
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('#credsCloseBtn').addEventListener('click', close);
  backdrop.querySelector('#credsCopyBtn').addEventListener('click', async ()=>{
    try {
      await navigator.clipboard.writeText(`ID: ${id}\n${t('za_f_password')}: ${password}`);
      const btn = backdrop.querySelector('#credsCopyBtn');
      btn.textContent = t('za_saved');
      setTimeout(()=>{ if(btn.isConnected) btn.textContent = t('za_creds_copy'); }, 1500);
    } catch (e) { /* clipboard denied — the visible text is still there to copy by hand */ }
  });
}

/* ---------------------------------------------------------------- */

// Inline status messages (form errors/confirmations) used to be prefixed
// with a raw emoji ('⚠️ '/'✅ ') set via textContent. Renders these as a
// proper Lucide icon instead so every icon in the app comes from the same
// icon set. Uses innerHTML (the message text itself is always either a
// static translation or a server-provided message, never raw user input),
// and re-runs lucide.createIcons() since the icon markup was just injected.
function setMsg(el, text, kind){
  if(!el) return;
  const icon = kind === 'success' ? 'check-circle-2' : 'alert-triangle';
  el.innerHTML = `<i data-lucide="${icon}" class="msg-icon ${kind}"></i><span>${text}</span>`;
  if (window.lucide) lucide.createIcons();
}
function setSuccessMsg(el, text){ setMsg(el, text, 'success'); }
function setErrorMsg(el, text){ setMsg(el, text, 'error'); }

// role/CURRENT_USER are populated from the real GET /api/me for the
// account behind the auth_token cookie — see loadCurrentUser() near
// the bottom of this file, which runs once on startup before the
// first render(). There is no client-side role switcher anymore: the
// server is the only source of truth for who's logged in and what
// title they hold.
let role = null;
let CURRENT_USER = null;

const TITLE_TO_ROLE_KEY = {
  'Head of Education': 'hoe',
  'Teacher Development Coordinator': 'tdc',
  'Supervisor': 'supervisor'
};

const ROLE_META = {
  hoe:        { titleKey: 'za_role_hoe', icon: 'graduation-cap', welcomeKey: 'za_welcome_hoe' },
  tdc:        { titleKey: 'za_role_tdc', icon: 'compass', welcomeKey: 'za_welcome_tdc' },
  supervisor: { titleKey: 'za_role_supervisor', icon: 'search', welcomeKey: 'za_welcome_sup' }
};

function initialsOf(name){
  if(!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0]||'') + (parts[1]?.[0]||'')).toUpperCase() || parts[0].slice(0,2).toUpperCase();
}

// Setup New School and Teacher Recruitment are field/operational work —
// only the Teacher Development Coordinator's nav shows them day-to-day.
// Head of Education's role here is oversight/approval (Approvals,
// Delegation) rather than doing the setup themselves; a non-delegated
// TDC who submits something still routes through Approvals for Head of
// Education to sign off on, same as before — this only changes which
// nav items each title sees, not what the backend permits.
const NAV = {
  hoe:[
    {sec:"za_sec_admin", items:[
      ["za_nav_dashboard","home"],["za_nav_schools","building-2"],
      ["za_nav_approvals","check-circle-2"],["za_nav_delegation","id-card"]
    ]},
    {sec:"za_sec_academic", items:[["za_nav_students","users"],["za_nav_teachers","graduation-cap"]]},
    {sec:"za_sec_oversight", items:[["za_nav_team","users-round"],["za_nav_school_performance","bar-chart-3"],["za_nav_messages","mail"],["za_nav_myid","credit-card"],["za_nav_profile","file-signature"]]}
  ],
  tdc:[
    {sec:"za_sec_admin", items:[
      ["za_nav_dashboard","home"],["za_nav_schools","building-2"],["za_nav_setup_school","plus-circle"],
      ["za_nav_recruitment","user-plus"],["za_nav_proposals","clipboard-list"]
    ]},
    {sec:"za_sec_academic", items:[["za_nav_subjects","book-open"],["za_nav_students","users"],["za_nav_teachers","graduation-cap"]]},
    {sec:"za_sec_oversight", items:[["za_nav_team","users-round"],["za_nav_school_performance","bar-chart-3"],["za_nav_messages","mail"],["za_nav_myid","credit-card"],["za_nav_profile","file-signature"]]}
  ],
  supervisor:[
    {sec:"za_sec_admin", items:[["za_nav_dashboard","home"],["za_nav_schools","building-2"],["za_nav_teachers","graduation-cap"]]},
    {sec:"za_sec_oversight", items:[["za_nav_team","users-round"],["za_nav_school_performance","bar-chart-3"],["za_nav_messages","mail"],["za_nav_myid","credit-card"]]}
  ]
};

let activePage = 'za_nav_dashboard';

function renderNav(){
  const wrap = document.getElementById('navScroll');
  wrap.innerHTML = '';
  NAV[role].forEach(section=>{
    const lbl = document.createElement('div');
    lbl.className='nav-label'; lbl.textContent = t(section.sec);
    wrap.appendChild(lbl);
    section.items.forEach(([key,icon])=>{
      const el = document.createElement('div');
      el.className = 'nav-item' + (key===activePage ? ' active':'');
      el.innerHTML = `<span class="ic"><i data-lucide="${icon}"></i></span><span>${t(key)}</span>`;
      el.onclick = ()=>{ activePage = key; render(); closeMobileNav(); };
      wrap.appendChild(el);
    });
  });
}

/* ---------------- Mobile nav drawer ---------------- */
function openMobileNav(){
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('navOverlay').classList.add('open');
}
function closeMobileNav(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('navOverlay').classList.remove('open');
}

function goToProfile(){
  activePage = 'za_nav_profile';
  render();
  closeMobileNav();
}

function renderTopChrome(){
  const meta = ROLE_META[role];
  const name = CURRENT_USER.admin_full_name || CURRENT_USER.user_id;
  // Sidebar footer: name only, no title text and no icon (icon element was removed from index.html)
  document.getElementById('roleTitleTxt').textContent = name;
  document.getElementById('roleIdTxt').textContent = CURRENT_USER.user_id;
  document.getElementById('whoName').textContent = name;
  document.getElementById('whoRole').textContent = t(meta.titleKey);
  // Topbar avatar doubles as the profile-picture button; falls back to
  // initials when no profile photo has been uploaded yet. This is the
  // everyday profile photo (avatar_url) — deliberately NOT id_photo_url,
  // which is the separate photo reserved for the printed ID card.
  const avatarEl = document.getElementById('avatarInit');
  if (CURRENT_USER.avatar_url) {
    avatarEl.innerHTML = `<img src="${API_BASE + CURRENT_USER.avatar_url}" alt="" class="avatar-img" />`;
  } else {
    avatarEl.textContent = initialsOf(name);
  }
  document.getElementById('pageTitle').textContent = t(activePage);
  const ay = CURRENT_USER.academic_year;
  document.getElementById('academicYearBadge').innerHTML = ay
    ? `<i data-lucide="calendar-days"></i> ${t('sa_topbar_academic_year', { year: ay.ec_year, gcRange: ay.gc_range })}`
    : `<i data-lucide="calendar-days"></i>`;
}

function errorPanel(err){
  const msg = (err && err.message) || String(err);
  return `<div class="panel"><div class="alert-box error">
    <div class="icon"><i data-lucide="alert-triangle"></i></div>
    <div class="body">${msg}</div>
  </div></div>`;
}

/* ---------------- Dashboard — live from /api/zonal/* -----------------
   Built from whichever of these the account's title can actually see:
   /api/zonal/schools (all titles, auto-scoped to zone vs. assigned
   schools), /api/zonal/students, /api/zonal/proposals and
   /api/zonal/incoming-teachers (Head of Education/Development
   Coordinator only), and /api/zonal/performance (used for the
   Supervisor's flagged-teachers card). Recent activity is assembled
   client-side from whichever of those the account fetched — there's
   no single "recent activity" endpoint. */
function dashboardSkeletonHTML(){
  // The calendar needs no API data (it's pure client-side date math), so it
  // paints immediately here instead of waiting behind the dashboard's
  // network calls — that wait was what made the calendar feel slow to load,
  // when really it was the cards/activity data above it that was slow.
  return `
  <div class="panel" id="dashDataPanel"><p class="hint">${t('za_loading')}</p></div>
  <div id="calWidgetHolder">${renderEthiopianCalendarWidget()}</div>`;
}

function fmtDate(d){
  if(!d) return '—';
  const dateObj = new Date(d);
  // Portal-wide convention: Ethiopian date first, G.C. date in brackets
  // (see the calendar widget below — same toEthiopianDate conversion).
  const ec = toEthiopianDate(dateObj);
  const ecMonth = t('eth_month_'+ec.monthKey);
  const gc = dateObj.toLocaleDateString(getCurrentLang()==='am' ? 'am-ET' : 'en-US', { year:'numeric', month:'short', day:'numeric' });
  return `${ec.day} ${ecMonth} ${ec.year} (${gc} GC)`;
}

async function loadAndRenderDashboard(){
  const content = document.getElementById('content');
  content.innerHTML = dashboardSkeletonHTML();
  try {
    if(role==='supervisor'){
      const [schools, performance] = await Promise.all([
        apiGet('/api/zonal/schools'),
        apiGet('/api/zonal/performance')
      ]);
      renderDashboard({ schools, performance });
    } else {
      const [schools, students, proposals, incoming] = await Promise.all([
        apiGet('/api/zonal/schools'),
        apiGet('/api/zonal/students'),
        apiGet('/api/zonal/proposals'),
        apiGet('/api/zonal/incoming-teachers')
      ]);
      renderDashboard({ schools, students, proposals, incoming });
    }
  } catch (err) {
    const panel = document.getElementById('dashDataPanel');
    if (panel) panel.outerHTML = errorPanel(err);
  }
}

function proposalActivityLine(p, schoolName){
  const label = proposalTypeLabel(p);
  const status = normStatus(p.status);
  const statusKey = status==='pending' ? 'za_act_status_pending' : status==='approved' ? 'za_act_status_approved' : 'za_act_status_rejected';
  return { school: schoolName || '—', event: `${label} — ${t(statusKey)}`, date: p.reviewed_at || p.created_at };
}

function incomingActivityLine(i){
  const status = normStatus(i.status);
  const key = status==='pending' ? 'za_act_teacher_pushed' : status==='accepted' ? 'za_act_teacher_accepted' : 'za_act_teacher_declined';
  return { school: schoolDisplayName(i.school_name, i.school_level), event: t(key), date: i.decided_at || i.created_at };
}

function renderDashboard({ schools, students, proposals, incoming, performance }){
  const meta = ROLE_META[role];
  let cards = `
    <div class="card">
      <div class="icon"><i data-lucide="building-2"></i></div>
      <div><div class="label">${t(role==='supervisor' ? 'za_assigned_schools' : 'za_total_schools')}</div>
      <div class="value">${schools.length}</div></div>
    </div>`;

  let activity = [];

  if(role!=='supervisor'){
    const totals = students.totals || { male: 0, female: 0, total: 0 };
    const pendingProposals = proposals.filter(p=>normStatus(p.status)==='pending').length;
    const pendingIncoming = incoming.filter(i=>normStatus(i.status)==='pending').length;
    cards += `
    <div class="card">
      <div class="icon"><i data-lucide="users"></i></div>
      <div><div class="label">${t('za_total_students')}</div>
      <div class="value">${totals.total.toLocaleString()}</div>
      <div class="subrow">♂ ${totals.male.toLocaleString()} &nbsp;&nbsp; ♀ ${totals.female.toLocaleString()}</div></div>
    </div>
    <div class="card alert">
      <div class="icon"><i data-lucide="file-pen-line"></i></div>
      <div><div class="label">${t('za_pending_proposals')}</div>
      <div class="value">${pendingProposals}</div></div>
    </div>
    <div class="card">
      <div class="icon"><i data-lucide="user-plus"></i></div>
      <div><div class="label">${t('za_incoming_pushed')}</div>
      <div class="value">${pendingIncoming}</div></div>
    </div>`;

    const schoolName = id => { const s = schools.find(s=>String(s.id)===String(id)); return s ? schoolDisplayName(s.school_name, s.school_level) : undefined; };
    activity = [
      ...proposals.map(p=>proposalActivityLine(p, schoolName(p.school_id))),
      ...incoming.map(incomingActivityLine)
    ].sort((a,b)=> new Date(b.date) - new Date(a.date)).slice(0, 6);
  } else {
    const flagged = performance.filter(p=>p.needs_followup);
    const schoolNameForFlagged = id => { const s = schools.find(s=>String(s.id)===String(id)); return s ? schoolDisplayName(s.school_name, s.school_level) : '—'; };
    cards += `
    <div class="card alert clickable" id="flaggedTeachersCard" role="button" tabindex="0">
      <div class="icon"><i data-lucide="alert-triangle"></i></div>
      <div><div class="label">${t('za_flagged_teachers')}</div>
      <div class="value">${flagged.length}</div></div>
      ${flagged.length ? '<i data-lucide="chevron-right" class="card-chevron"></i>' : ''}
    </div>`;

    const schoolName = schoolNameForFlagged;
    activity = flagged
      .sort((a,b)=> (b.days_since_marks_upload ?? 9999) - (a.days_since_marks_upload ?? 9999))
      .slice(0, 6)
      .map(p=>({
        school: schoolName(p.school_id),
        event: `${p.full_name} — ${p.days_since_marks_upload!=null ? t('za_act_needs_followup', { days: p.days_since_marks_upload }) : t('za_act_no_marks_yet')}`,
        date: p.last_marks_upload
      }));

    // Kept for the flagged-teachers popup (renderFollowUpModal) — needs
    // the full flagged list + school lookup, not just the 6-row activity
    // slice above.
    currentFlaggedTeachers = flagged;
    currentFlaggedSchoolName = schoolNameForFlagged;
  }

  const activityRows = activity.length
    ? activity.map(a=>`<tr><td>${a.school}</td><td>${a.event}</td><td>${fmtDate(a.date)}</td></tr>`).join('')
    : `<tr><td colspan="3" class="hint">${t('za_activity_empty')}</td></tr>`;

  const panel = document.getElementById('dashDataPanel');
  const dataHTML = `
  <div class="welcome">
    <h2>${t(meta.welcomeKey)}</h2>
    <p>${t('za_welcome_sub')}</p>
  </div>
  <div class="cards">${cards}</div>
  <div class="panel">
    <h3><i data-lucide="clipboard-list"></i> ${t('za_recent_activity')}</h3>
    <table>
      <tr><th>${t('za_th_school')}</th><th>Event</th><th>Date</th></tr>
      ${activityRows}
    </table>
    ${role==='supervisor' ? `<div class="hint">${t('za_locked_note')}</div>` : ''}
  </div>`;
  if (panel) panel.outerHTML = dataHTML;
  else document.getElementById('content').insertAdjacentHTML('afterbegin', dataHTML);
  if (window.lucide) window.lucide.createIcons();

  const flaggedCard = document.getElementById('flaggedTeachersCard');
  if(flaggedCard){
    const open = ()=> openFollowUpModal();
    flaggedCard.addEventListener('click', open);
    flaggedCard.addEventListener('keydown', e=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); open(); } });
  }
}

/* ---------------------------------------------------------------
   "Teachers Needing Follow-up" detail popup — the Supervisor
   dashboard's flagged-teachers card used to just be a number with no
   way to see who was behind it or why; this lists each flagged
   teacher with their school and the specific reason(s) they were
   flagged (low attendance over the last 14 days and/or marks not
   uploaded / overdue — see needs_followup in
   GET /api/zonal/performance), reusing whatever the dashboard already
   fetched rather than a second network call.
   --------------------------------------------------------------- */
let currentFlaggedTeachers = [];
let currentFlaggedSchoolName = () => '—';

function followUpReasons(p){
  const reasons = [];
  if(p.periods_logged_last_14_days > 0 && (p.periods_present_last_14_days / p.periods_logged_last_14_days) < 0.8){
    const pct = Math.round((p.periods_present_last_14_days / p.periods_logged_last_14_days) * 100);
    reasons.push(t('za_followup_reason_attendance', { pct }));
  }
  if(p.days_since_marks_upload == null){
    reasons.push(t('za_followup_reason_no_marks'));
  } else if(p.days_since_marks_upload > 14){
    reasons.push(t('za_followup_reason_marks_overdue', { days: p.days_since_marks_upload }));
  }
  return reasons.length ? reasons : [t('za_followup_reason_unknown')];
}

function openFollowUpModal(){
  const backdrop = document.createElement('div');
  backdrop.className = 'perf-modal-backdrop';
  const rowsHTML = currentFlaggedTeachers.length ? currentFlaggedTeachers
    .sort((a,b)=> (b.days_since_marks_upload ?? 9999) - (a.days_since_marks_upload ?? 9999))
    .map(p=>`
    <div class="followup-row">
      <div class="followup-row-top">
        <span class="followup-name">${p.full_name}</span>
        <span class="followup-school">${currentFlaggedSchoolName(p.school_id)}</span>
      </div>
      <ul class="followup-reasons">
        ${followUpReasons(p).map(r=>`<li>${r}</li>`).join('')}
      </ul>
    </div>`).join('') : `<p class="hint">${t('za_perf_none_flagged')}</p>`;

  backdrop.innerHTML = `<div class="perf-modal">
    <button class="perf-modal-close" id="followUpModalClose"><i data-lucide="x"></i></button>
    <h3 style="margin-bottom:4px;">${t('za_flagged_teachers')}</h3>
    <p class="hint" style="margin-bottom:0;">${t('za_followup_modal_sub')}</p>
    <div class="perf-detail-section">${rowsHTML}</div>
  </div>`;
  document.body.appendChild(backdrop);
  if (window.lucide) lucide.createIcons();
  backdrop.addEventListener('click', e=>{ if(e.target===backdrop) backdrop.remove(); });
  backdrop.querySelector('#followUpModalClose').addEventListener('click', ()=> backdrop.remove());
}

/* ---------------- Total Students — live from /api/zonal/students ---- */
/* ---------------- Total Students — full roster, live from
   /api/zonal/students-directory ---------------------------------------
   One row per student (ID, name, class, stream, section, enrollment
   year, status) across every school in the zone — not the old
   class/section headcount summary. enrollment_year comes from when the
   student's record was first created (no separate per-academic-year
   history table exists yet), which is close enough to browse cohorts
   by intake year even though it won't show a student's class in a
   *past* year. currentStudentRows/currentStudentSchools are kept
   around so the Download CSV button can export exactly what's on
   screen without a second fetch. */
let currentStudentRows = [];
let currentStudentSchools = [];

// enrollment_year is stored as a plain Gregorian year (see the note
// above). The rest of the portal always shows dates/years Ethiopian-
// first with the Gregorian value in brackets (see fmtDate and the
// topbar's academicYearBadge, both driven by the same Sept-11 cutoff
// used server-side in approximateEthiopianYear) — this mirrors that so
// the Enrollment Year column isn't the one place still showing a bare
// GC number. A single stored GC year corresponds to the EC academic
// year that ends in it (Sept of gcYear-1 through ~Sept of gcYear), so
// the offset is 8, not 7 (contrast getCurrentAcademicYearLabel's
// ecYear+7 for gcStart).
function enrollmentYearLabel(gcYear){
  if(gcYear == null || gcYear === '') return '—';
  const gc = Number(gcYear);
  if(!Number.isFinite(gc)) return String(gcYear);
  return `${gc - 8} (${gc} GC)`;
}

function studentsSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="users"></i> ${t('za_students_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderStudents(filters){
  const content = document.getElementById('content');
  if(role==='supervisor'){
    content.innerHTML = `<div class="panel"><h3><i data-lucide="users"></i> ${t('za_students_title')}</h3>
      <p class="hint">${t('za_locked_note')}</p></div>`;
    return;
  }
  try {
    const [schools, data] = await Promise.all([
      apiGet('/api/zonal/schools'),
      apiGet('/api/zonal/students-directory', filters)
    ]);
    renderStudentsPanel(schools, data, filters || {});
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

const STUDENT_STATUS_PILL = {
  'Active':                    'ok',
  'Graduated':                 'grad',
  'Dropped':                   'bad',
  'Transferred - Pending':     'warn',
  'Transferred - Completed':   'warn'
};

const STUDENT_STATUS_KEY = {
  'Active':                  'za_status_active',
  'Graduated':                'za_status_graduated',
  'Dropped':                  'za_status_dropped',
  'Transferred - Pending':    'za_status_transferred_pending',
  'Transferred - Completed':  'za_status_transferred_completed'
};

function studentStatusLabel(status){
  const key = STUDENT_STATUS_KEY[status];
  return key ? t(key) : (status || '—');
}

function studentStatusPill(status){
  const cls = STUDENT_STATUS_PILL[status] || 'warn';
  return `<span class="pill ${cls}">${studentStatusLabel(status)}</span>`;
}

const STREAM_KEY = {
  'General': 'za_stream_general',
  'Natural': 'za_stream_natural',
  'Social': 'za_stream_social'
};
function streamLabel(stream){
  const key = STREAM_KEY[stream];
  return key ? t(key) : (stream || '—');
}

function renderStudentsPanel(schools, data, filters){
  const rows = data.rows || [];
  const years = data.years || [];
  currentStudentRows = rows;
  currentStudentSchools = schools;

  const totals = rows.reduce((acc, r)=>{
    acc.total++;
    if(r.sex==='Male') acc.male++; else if(r.sex==='Female') acc.female++;
    return acc;
  }, { male: 0, female: 0, total: 0 });

  const schoolOpts = schools.map(s=>`<option value="${s.id}" ${String(filters.school_id)===String(s.id)?'selected':''}>${schoolDisplayName(s.school_name, s.school_level)}</option>`).join('');
  const classOpts = ['9','10','11','12'].map(c=>`<option value="${c}" ${filters.class_level===c?'selected':''}>${t('za_grade_short',{level:c})}</option>`).join('');
  const streamOpts = ['General','Natural','Social'].map(s=>`<option value="${s}" ${filters.stream===s?'selected':''}>${streamLabel(s)}</option>`).join('');
  const sectionOpts = ['A','B','C','D'].map(s=>`<option value="${s}" ${filters.section===s?'selected':''}>${s}</option>`).join('');
  const STATUS_VALUES = ['Active','Graduated','Dropped','Transferred - Pending','Transferred - Completed'];
  const statusOpts = STATUS_VALUES.map(s=>`<option value="${s}" ${filters.status===s?'selected':''}>${studentStatusLabel(s)}</option>`).join('');
  const yearOpts = years.map(y=>`<option value="${y}" ${String(filters.enrollment_year)===String(y)?'selected':''}>${enrollmentYearLabel(y)}</option>`).join('');

  const tableRows = rows.length ? rows.map(r=>`
    <tr>
      <td>${r.student_id}</td><td>${r.full_name}</td><td>${t('za_grade_short',{level:r.class_level})}</td>
      <td>${streamLabel(r.stream)}</td><td>${r.section || '—'}</td><td>${enrollmentYearLabel(r.enrollment_year)}</td>
      <td>${studentStatusPill(r.status)}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="hint">${t('za_students_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="users"></i> ${t('za_students_title')}</h3>
    <div class="filters">
      <select id="filt_school"><option value="">${t('za_all')} — ${t('za_filters_school')}</option>${schoolOpts}</select>
      <select id="filt_class"><option value="">${t('za_all')} — ${t('za_filters_class')}</option>${classOpts}</select>
      <select id="filt_stream"><option value="">${t('za_all')} — ${t('za_filters_stream')}</option>${streamOpts}</select>
      <select id="filt_section"><option value="">${t('za_all')} — ${t('za_filters_section')}</option>${sectionOpts}</select>
      <select id="filt_status"><option value="">${t('za_all')} — ${t('za_filters_status')}</option>${statusOpts}</select>
      <select id="filt_year"><option value="">${t('za_all')} — ${t('za_filters_year')}</option>${yearOpts}</select>
      <button class="btn ghost" id="btnDownloadCsv">⬇ ${t('za_download_csv')}</button>
    </div>
    <div class="gender-strip">
      <div class="gender-chip total"><div class="n">${totals.total}</div><div class="l">${t('za_total')}</div></div>
      <div class="gender-chip male"><div class="n">${totals.male}</div><div class="l">♂ ${t('za_male')}</div></div>
      <div class="gender-chip female"><div class="n">${totals.female}</div><div class="l">♀ ${t('za_female')}</div></div>
    </div>
    <div class="table-wrap sticky-head">
      <table>
        <thead>
          <tr>
            <th>${t('za_th_id')}</th><th>${t('za_th_name')}</th><th>${t('za_th_class')}</th><th>${t('za_th_stream')}</th>
            <th>${t('za_th_section')}</th><th>${t('za_th_enroll_year')}</th><th>${t('za_th_status')}</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
  </div>`;

  const refetch = ()=>{
    loadAndRenderStudents({
      school_id: document.getElementById('filt_school').value,
      class_level: document.getElementById('filt_class').value,
      stream: document.getElementById('filt_stream').value,
      section: document.getElementById('filt_section').value,
      status: document.getElementById('filt_status').value,
      enrollment_year: document.getElementById('filt_year').value
    });
  };
  ['filt_school','filt_class','filt_stream','filt_section','filt_status','filt_year'].forEach(id=>{
    document.getElementById(id).addEventListener('change', refetch);
  });
  document.getElementById('btnDownloadCsv').addEventListener('click', downloadStudentsCsv);
}

function csvEscape(v){
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

function downloadStudentsCsv(){
  const schoolName = id => { const s = currentStudentSchools.find(s=>String(s.id)===String(id)); return s ? schoolDisplayName(s.school_name, s.school_level) : ''; };
  const header = ['School', t('za_th_id'), t('za_th_name'), t('za_th_class'), t('za_th_stream'), t('za_th_section'), t('za_th_enroll_year'), t('za_th_status')];
  const lines = [header.map(csvEscape).join(',')];
  currentStudentRows.forEach(r=>{
    lines.push([
      schoolName(r.school_id), r.student_id, r.full_name, t('za_grade_short',{level:r.class_level}),
      r.stream || '', r.section || '', enrollmentYearLabel(r.enrollment_year), studentStatusLabel(r.status)
    ].map(csvEscape).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zone-students-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- School Performance — live from
   /api/zonal/school-performance ----------------------------------------
   Every zonal_admins title sees the pie chart + bucketed list (low /
   average / good / excellence); only a Supervisor can click a school
   to open the drill-down modal (backed by
   /api/zonal/school-performance/:id/details) showing exactly what's
   dragging the score down — teacher punctuality, overdue marks, or
   sections with no teacher assigned at all. */
const PERF_BUCKETS = [
  { key:'excellence', color:'#1f8a4c', labelKey:'za_perf_excellence' },
  { key:'good',        color:'#c99a4a', labelKey:'za_perf_good' },
  { key:'average',     color:'#b3791a', labelKey:'za_perf_average' },
  { key:'low',         color:'#c0392b', labelKey:'za_perf_low' },
  { key:'no_data',     color:'#c7d0cb', labelKey:'za_perf_no_data' }
];

function performanceSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="bar-chart-3"></i> ${t('za_school_performance_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderPerformance(){
  const content = document.getElementById('content');
  try {
    const rows = await apiGet('/api/zonal/school-performance');
    renderPerformancePanel(rows);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function perfPieSVG(counts, total){
  const r = 70, cx = 90, cy = 90;
  if(!total) return `<svg viewBox="0 0 180 180"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e4e9e6" stroke-width="26"/></svg>`;
  let angleStart = -90;
  const arcs = PERF_BUCKETS.filter(b=>counts[b.key]).map(b=>{
    const frac = counts[b.key] / total;
    const angleEnd = angleStart + frac*360;
    const large = (angleEnd - angleStart) > 180 ? 1 : 0;
    const toXY = a => [cx + r*Math.cos(a*Math.PI/180), cy + r*Math.sin(a*Math.PI/180)];
    const [x1,y1] = toXY(angleStart), [x2,y2] = toXY(angleEnd);
    const path = frac >= 0.999
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${b.color}" stroke-width="26"/>`
      : `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}" fill="none" stroke="${b.color}" stroke-width="26" stroke-linecap="butt"/>`;
    angleStart = angleEnd;
    return path;
  }).join('');
  return `<svg viewBox="0 0 180 180">${arcs}</svg>`;
}

function renderPerformancePanel(rows){
  const counts = { excellence:0, good:0, average:0, low:0, no_data:0 };
  rows.forEach(r=> counts[r.category] = (counts[r.category]||0) + 1);
  const total = rows.length;

  const legend = PERF_BUCKETS.map(b=>`
    <div class="perf-legend-row">
      <span class="perf-legend-dot" style="background:${b.color}"></span>
      <span>${t(b.labelKey)}</span>
      <span class="n">${counts[b.key]||0}</span>
    </div>`).join('');

  const canDrill = role === 'supervisor';
  const schoolRows = rows.length ? rows.map(r=>`
    <div class="perf-school-row ${canDrill ? 'clickable' : ''}" ${canDrill ? `data-school-id="${r.school_id}"` : ''}>
      <div style="flex:1;min-width:0;">
        <div class="psr-name">${schoolDisplayName(r.school_name, r.school_level)}</div>
        <div class="psr-sub">${r.score != null ? t('za_perf_score', { score: r.score }) : t('za_perf_no_data')}${r.flagged_teachers ? ' · ' + t('za_perf_flagged', { count: r.flagged_teachers }) : ''}</div>
      </div>
      <span class="perf-bucket-pill ${r.category}">${t(PERF_BUCKETS.find(b=>b.key===r.category).labelKey)}</span>
      ${canDrill ? '<i data-lucide="chevron-right"></i>' : ''}
    </div>`).join('') : `<p class="hint">${t('za_schools_empty')}</p>`;

  document.getElementById('content').innerHTML = `
  <div class="perf-layout">
    <div class="perf-pie-card">
      ${perfPieSVG(counts, total)}
      <div class="perf-legend">${legend}</div>
    </div>
    <div class="panel">
      <h3><i data-lucide="bar-chart-3"></i> ${t('za_school_performance_title')}</h3>
      ${!canDrill ? `<p class="hint">${t('za_perf_view_only_note')}</p>` : ''}
      <div class="perf-school-list">${schoolRows}</div>
    </div>
  </div>`;

  if(canDrill){
    document.querySelectorAll('.perf-school-row[data-school-id]').forEach(el=>{
      el.addEventListener('click', ()=> openPerformanceDetail(el.dataset.schoolId));
    });
  }
}

async function openPerformanceDetail(schoolId){
  const backdrop = document.createElement('div');
  backdrop.className = 'perf-modal-backdrop';
  backdrop.innerHTML = `<div class="perf-modal"><p class="hint">${t('za_loading')}</p></div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', e=>{ if(e.target===backdrop) backdrop.remove(); });

  try {
    const d = await apiGet(`/api/zonal/school-performance/${schoolId}/details`);
    const teacherRow = tr => `<div class="perf-issue-row"><span>${tr.full_name}</span><span>${tr.attendance_rate!=null ? tr.attendance_rate+'%' : '—'}</span></div>`;
    const marksRow = tr => `<div class="perf-issue-row"><span>${tr.full_name}</span><span>${tr.days_since_marks_upload!=null ? tr.days_since_marks_upload+'d' : t('za_no_uploads_yet')}</span></div>`;
    const gapRow = g => `<div class="perf-issue-row"><span>${t('za_grade_short',{level:g.class_level})}-${g.section}${g.stream? ' ('+g.stream+')':''}</span><span>${t('za_perf_no_teacher')}</span></div>`;

    backdrop.querySelector('.perf-modal').innerHTML = `
      <button class="perf-modal-close" id="perfModalClose"><i data-lucide="x"></i></button>
      <h3 style="margin-bottom:4px;">${schoolDisplayName(d.school_name, d.school_level)}</h3>
      <p class="hint" style="margin-bottom:0;">${t('za_perf_detail_sub')}</p>

      <div class="perf-detail-section">
        <h4><i data-lucide="clock-alert"></i> ${t('za_perf_teacher_punctuality')} (${d.teacher_punctuality.length})</h4>
        ${d.teacher_punctuality.length ? d.teacher_punctuality.map(teacherRow).join('') : `<p class="hint">${t('za_perf_none_flagged')}</p>`}
      </div>

      <div class="perf-detail-section">
        <h4><i data-lucide="file-clock"></i> ${t('za_perf_marks_overdue')} (${d.marks_overdue.length})</h4>
        ${d.marks_overdue.length ? d.marks_overdue.map(marksRow).join('') : `<p class="hint">${t('za_perf_none_flagged')}</p>`}
      </div>

      <div class="perf-detail-section">
        <h4><i data-lucide="user-x"></i> ${t('za_perf_no_teacher_section')} (${d.no_teacher_assigned.length})</h4>
        ${d.no_teacher_assigned.length ? d.no_teacher_assigned.map(gapRow).join('') : `<p class="hint">${t('za_perf_none_flagged')}</p>`}
      </div>

      <div class="perf-detail-section">
        <h4><i data-lucide="users"></i> ${t('za_perf_student_summary')}</h4>
        <div class="perf-issue-row"><span>${t('za_total_students')}</span><span>${d.student_summary.total_students}</span></div>
        <div class="perf-issue-row"><span>${t('za_perf_dropout_rate')}</span><span>${d.student_summary.dropout_rate!=null ? d.student_summary.dropout_rate+'%' : '—'}</span></div>
      </div>`;
    backdrop.querySelector('#perfModalClose').addEventListener('click', ()=> backdrop.remove());
  } catch (err) {
    backdrop.querySelector('.perf-modal').innerHTML = errorPanel(err) + `<button class="btn ghost" id="perfModalClose2">${t('za_close')}</button>`;
    backdrop.querySelector('#perfModalClose2').addEventListener('click', ()=> backdrop.remove());
  }
}

/* ---- Setup New School: real cascading region -> zone -> woreda -> kebele,
   backed by /api/zonal/lookup/* ---- */
function setupSchoolSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="plus-circle"></i> ${t('za_setup_title')}</h3><p class="hint">Loading…</p></div>`;
}

async function loadAndRenderSetupSchool(){
  const content = document.getElementById('content');
  try {
    const regions = await apiGet('/api/zonal/lookup/regions');
    renderSetupSchoolPanel(regions);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function renderSetupSchoolPanel(regions){
  const regionOpts = regions.map(r=>`<option value="${r.region_id}">${r.region_name}</option>`).join('');
  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="plus-circle"></i> ${t('za_setup_title')}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="f_name">${t('za_f_school_name')}</label>
        <input type="text" id="f_name" placeholder="e.g. Newland">
      </div>
      <div class="form-field">
        <label for="f_level">${t('za_f_school_level')}</label>
        <select id="f_level">
          <option value="">${t('za_pick_school_level')}</option>
          <option value="SECONDARY SCHOOL">${t('za_school_level_secondary')}</option>
          <option value="PRIMARY SCHOOL">${t('za_school_level_primary')}</option>
        </select>
      </div>
      <div class="form-field">
        <label for="f_prefix_preview">${t('za_f_school_prefix')}</label>
        <input type="text" id="f_prefix_preview" placeholder="—" readonly disabled>
      </div>
      <div class="form-field">
        <label for="f_moe">${t('za_f_moe_code')}</label>
        <input type="text" id="f_moe" placeholder="e.g. 1203010102">
      </div>
      <div class="form-field">
        <label for="f_region">${t('za_f_region')}</label>
        <select id="f_region"><option value="">${t('za_pick_region')}</option>${regionOpts}</select>
      </div>
      <div class="form-field">
        <label for="f_zone">${t('za_f_zone')}</label>
        <select id="f_zone" disabled><option value="">${t('za_pick_zone')}</option></select>
      </div>
      <div class="form-field">
        <label for="f_woreda">${t('za_f_woreda')}</label>
        <select id="f_woreda" disabled><option value="">${t('za_pick_woreda')}</option></select>
      </div>
      <div class="form-field">
        <label for="f_kebele">${t('za_f_kebele')}</label>
        <select id="f_kebele" disabled><option value="">${t('za_pick_kebele')}</option></select>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnSaveSchool">${t('za_save_school')}</button>
      <button class="btn ghost" id="btnCancelSchool">${t('za_cancel')}</button>
    </div>
    <p class="hint" id="setupFormMsg"></p>
  </div>`;
  wireCascadingSelects();
  wireSchoolPrefixPreview();

  document.getElementById('btnCancelSchool').onclick = ()=>{ activePage='za_nav_dashboard'; render(); };
  document.getElementById('btnSaveSchool').onclick = submitNewSchool;
}

// Mirrors buildSchoolPrefixBase() in server.js — this is a live preview
// only, so the person sees what they'll get before saving. The server
// computes the real, final prefix itself and may add a 2/3/4... suffix
// if this exact prefix is already taken by another school; it never
// trusts a prefix sent from the browser.
function computeSchoolPrefixPreview(name, level){
  const initials = name.trim().split(/\s+/).filter(Boolean).map(w=>w[0].toUpperCase()).join('');
  if(!initials || !level) return '';
  const levelCode = level === 'PRIMARY SCHOOL' ? 'PS' : 'SS';
  return initials + levelCode;
}

function wireSchoolPrefixPreview(){
  const nameEl = document.getElementById('f_name');
  const levelEl = document.getElementById('f_level');
  const previewEl = document.getElementById('f_prefix_preview');
  if(!nameEl || !levelEl || !previewEl) return;
  const update = ()=>{ previewEl.value = computeSchoolPrefixPreview(nameEl.value, levelEl.value); };
  nameEl.addEventListener('input', update);
  levelEl.addEventListener('change', update);
}

function fillSelect(el, rows, idKey, nameKey, placeholder){
  el.innerHTML = `<option value="">${placeholder}</option>` +
    rows.map(r=>`<option value="${r[idKey]}">${r[nameKey]}</option>`).join('');
}

function wireCascadingSelects(){
  const regionEl = document.getElementById('f_region');
  const zoneEl = document.getElementById('f_zone');
  const woredaEl = document.getElementById('f_woreda');
  const kebeleEl = document.getElementById('f_kebele');
  if(!regionEl) return;

  regionEl.addEventListener('change', async ()=>{
    fillSelect(zoneEl, [], 'zone_id', 'zone_name', t('za_pick_zone')); zoneEl.disabled = true;
    fillSelect(woredaEl, [], 'woreda_id', 'woreda_name', t('za_pick_woreda')); woredaEl.disabled = true;
    fillSelect(kebeleEl, [], 'kebele_id', 'kebele_name', t('za_pick_kebele')); kebeleEl.disabled = true;
    if(!regionEl.value) return;
    try {
      const zones = await apiGet('/api/zonal/lookup/zones', { region_id: regionEl.value });
      fillSelect(zoneEl, zones, 'zone_id', 'zone_name', t('za_pick_zone'));
      zoneEl.disabled = zones.length===0;
    } catch (err) { setErrorMsg(document.getElementById('setupFormMsg'), err.message); }
  });

  zoneEl.addEventListener('change', async ()=>{
    fillSelect(woredaEl, [], 'woreda_id', 'woreda_name', t('za_pick_woreda')); woredaEl.disabled = true;
    fillSelect(kebeleEl, [], 'kebele_id', 'kebele_name', t('za_pick_kebele')); kebeleEl.disabled = true;
    if(!zoneEl.value) return;
    try {
      const woredas = await apiGet('/api/zonal/lookup/woredas', { zone_id: zoneEl.value });
      fillSelect(woredaEl, woredas, 'woreda_id', 'woreda_name', t('za_pick_woreda'));
      woredaEl.disabled = woredas.length===0;
    } catch (err) { setErrorMsg(document.getElementById('setupFormMsg'), err.message); }
  });

  woredaEl.addEventListener('change', async ()=>{
    fillSelect(kebeleEl, [], 'kebele_id', 'kebele_name', t('za_pick_kebele')); kebeleEl.disabled = true;
    if(!woredaEl.value) return;
    try {
      const kebeles = await apiGet('/api/zonal/lookup/kebeles', { woreda_id: woredaEl.value });
      fillSelect(kebeleEl, kebeles, 'kebele_id', 'kebele_name', t('za_pick_kebele'));
      kebeleEl.disabled = kebeles.length===0;
    } catch (err) { setErrorMsg(document.getElementById('setupFormMsg'), err.message); }
  });
}

async function submitNewSchool(){
  const msg = document.getElementById('setupFormMsg');
  const body = {
    school_name: document.getElementById('f_name').value.trim(),
    school_level: document.getElementById('f_level').value,
    moe_school_code: document.getElementById('f_moe').value.trim() || null,
    region_id: document.getElementById('f_region').value || null,
    woreda_id: document.getElementById('f_woreda').value || null,
    kebele_id: document.getElementById('f_kebele').value || null
  };
  if(!body.school_name || !body.school_level){
    setErrorMsg(msg, t('za_setup_required'));
    return;
  }
  try {
    const result = await apiPost('/api/zonal/schools', body);
    setSuccessMsg(msg, result.message);
  } catch (err) {
    setErrorMsg(msg, err.message);
  }
}

function genericPanel(titleKey, icon){
  return `<div class="panel"><h3><i data-lucide="${icon}"></i> ${t(titleKey)}</h3>
    <p class="hint">${t('za_generic_hint')}</p></div>`;
}

/* ---------------- Schools — live from /api/zonal/schools ------------ */
function schoolsSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="building-2"></i> ${t('za_schools_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderSchools(){
  const content = document.getElementById('content');
  try {
    const schools = await apiGet('/api/zonal/schools');
    renderSchoolsPanel(schools);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function renderSchoolsPanel(schools){
  const rows = schools.length ? schools.map(s=>`
    <tr>
      <td>${schoolDisplayName(s.school_name, s.school_level)}</td><td>${s.school_prefix || '—'}</td><td>${s.moe_school_code || '—'}</td>
      <td>${s.woreda || '—'}</td><td>${s.region || '—'}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="hint">${t('za_schools_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="building-2"></i> ${t('za_schools_title')}</h3>
    <table>
      <tr><th>${t('za_th_school')}</th><th>${t('za_th_prefix')}</th><th>${t('za_th_moe')}</th><th>${t('za_th_woreda')}</th><th>${t('za_th_region')}</th></tr>
      ${rows}
    </table>
  </div>`;
}

function navHasPage(key){
  return NAV[role].some(section => section.items.some(([k]) => k === key));
}

/* ==================================================================
   Approvals (Head of Education) — live from /api/zonal/proposals
   Lists proposals awaiting the HoE's decision plus recently-decided
   ones for audit. Backend contract:
     GET  /api/zonal/proposals                 -> [{id, proposal_type,
          school_id, submitted_by, status, note, decision_note,
          created_at, reviewed_at}]
     POST /api/zonal/proposals/:id/decide       body:{decision:'approved'|'rejected', note}
   ================================================================== */
function approvalsSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="check-circle-2"></i> ${t('za_approvals_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderApprovals(){
  const content = document.getElementById('content');
  try {
    const [schools, proposals] = await Promise.all([
      apiGet('/api/zonal/schools'),
      apiGet('/api/zonal/proposals')
    ]);
    renderApprovalsPanel(schools, proposals);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function proposalTypeLabel(p){
  if(p.proposal_type==='hire_teacher') return t('za_act_proposal_hire');
  if(p.proposal_type==='transfer_teacher') return t('za_act_proposal_transfer');
  if(p.proposal_type==='assign_supervisor') return t('za_act_proposal_supervisor');
  return t('za_act_proposal_admin');
}

function proposalSubjectLine(p){
  const payload = p.payload || {};
  if(p.proposal_type==='transfer_teacher') return payload.teacher_name || payload.teacher_id || '—';
  const name = [payload.first_name, payload.middle_name, payload.last_name].filter(Boolean).join(' ');
  return name || '—';
}

function renderApprovalsPanel(schools, proposals){
  const schoolName = id => { const s = schools.find(s=>String(s.id)===String(id)); return s ? schoolDisplayName(s.school_name, s.school_level) : '—'; };
  const decided = proposals.filter(p=>normStatus(p.status)!=='pending')
    .sort((a,b)=> new Date(b.reviewed_at||b.created_at) - new Date(a.reviewed_at||a.created_at)).slice(0,10);

  const pendingHTML = pending.length ? pending.map(p=>`
    <div class="queue-item" data-id="${p.proposal_id}">
      <div class="qi-main">
        <div class="qi-title">${proposalTypeLabel(p)} — ${proposalSubjectLine(p)}</div>
        <div class="qi-sub">${schoolName(p.school_id)} · ${t('za_submitted_by')}: ${p.proposed_by || '—'} · ${fmtDate(p.created_at)}</div>
      </div>
      <div class="queue-actions">
        <button class="btn primary sm" data-act="approve" data-id="${p.proposal_id}">${t('za_approve')}</button>
        <button class="btn danger sm" data-act="reject" data-id="${p.proposal_id}">${t('za_reject')}</button>
      </div>
    </div>`).join('') : `<p class="hint">${t('za_approvals_empty')}</p>`;

  const decidedRows = decided.length ? decided.map(p=>`
    <tr>
      <td>${proposalTypeLabel(p)}</td><td>${proposalSubjectLine(p)}</td><td>${schoolName(p.school_id)}</td>
      <td>${normStatus(p.status)==='approved' ? `<span class="pill ok">${t('za_act_status_approved')}</span>` : `<span class="pill bad">${t('za_act_status_rejected')}</span>`}</td>
      <td>${fmtDate(p.reviewed_at)}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="hint">${t('za_activity_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="check-circle-2"></i> ${t('za_approvals_title')}</h3>
    <div id="approvalsQueue">${pendingHTML}</div>
    <p class="hint" id="approvalsMsg"></p>
  </div>
  <div class="panel">
    <h3><i data-lucide="clipboard-list"></i> ${t('za_approvals_history')}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t('za_th_type')}</th><th>${t('za_th_name')}</th><th>${t('za_th_school')}</th><th>${t('za_th_status')}</th><th>${t('za_th_decided')}</th></tr>
      ${decidedRows}
    </table></div>
  </div>`;

  document.getElementById('approvalsQueue').addEventListener('click', async (e)=>{
    const btn = e.target.closest('button[data-act]');
    if(!btn) return;
    const id = btn.dataset.id;
    try {
      let successText;
      if(btn.dataset.act==='approve'){
        const result = await apiPost(`/api/zonal/proposals/${id}/approve`);
        successText = result.message;
      } else {
        const reason = prompt(t('sa_prompt_rejection_reason')) || '';
        await apiPost(`/api/zonal/proposals/${id}/reject`, { reason });
        successText = t('za_proposal_rejected');
      }
      // Reload FIRST (this rebuilds #approvalsMsg from scratch), then set
      // the confirmation text on the freshly-rendered element — otherwise
      // the reload wipes the message before the user ever sees it.
      await loadAndRenderApprovals();
      const msg = document.getElementById('approvalsMsg');
      if(msg) setSuccessMsg(msg, successText);
    } catch (err) {
      const msg = document.getElementById('approvalsMsg');
      if(msg) setErrorMsg(msg, err.message);
    }
  });
}

/* ==================================================================
   Delegate Authority (Head of Education) — live from:
     GET  /api/zonal/teamleaders                 -> [{admin_id, first_name, last_name, can_act_independently}]
     POST /api/zonal/teamleader/:id/delegate       body:{can_act_independently}
   Each Teacher Development Coordinator in the zone can be delegated
   independently, so this renders one toggle row per person rather than
   a single zone-wide switch.
   ================================================================== */
function delegationSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="id-card"></i> ${t('za_delegation_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderDelegation(){
  const content = document.getElementById('content');
  try {
    const coordinators = await apiGet('/api/zonal/teamleaders');
    renderDelegationPanel(coordinators);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function renderDelegationPanel(coordinators){
  const rows = coordinators.length ? coordinators.map(c=>`
    <div class="toggle-row" data-id="${c.admin_id}">
      <label class="switch"><input type="checkbox" class="delegateToggle" data-id="${c.admin_id}" ${c.can_act_independently?'checked':''}><span class="slider"></span></label>
      <div>
        <div class="qi-title">${c.first_name} ${c.last_name}</div>
        <div class="qi-sub">${c.can_act_independently ? t('za_delegation_active_note') : t('za_delegation_inactive_note')}</div>
      </div>
    </div>`).join('') : `<p class="hint">${t('za_delegation_empty')}</p>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="id-card"></i> ${t('za_delegation_title')}</h3>
    <div id="delegationList">${rows}</div>
    <p class="hint" id="delegationMsg"></p>
  </div>`;

  document.querySelectorAll('.delegateToggle').forEach(toggle=>{
    toggle.addEventListener('change', async ()=>{
      try {
        const result = await apiPost(`/api/zonal/teamleader/${toggle.dataset.id}/delegate`, { can_act_independently: toggle.checked });
        await loadAndRenderDelegation();
        const newMsg = document.getElementById('delegationMsg');
        if(newMsg) setSuccessMsg(newMsg, result.message);
      } catch (err) {
        toggle.checked = !toggle.checked;
        const msg = document.getElementById('delegationMsg');
        if(msg) setErrorMsg(msg, err.message);
      }
    });
  });
}

/* ==================================================================
   Team — a zone-wide "who is who" directory: every Head of Education,
   Development Coordinator, and Supervisor in the zone, with the
   school(s) they're assigned to. Read-only, available to all three
   titles. — live from GET /api/zonal/team.
   ================================================================== */
function teamSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="users-round"></i> ${t('za_team_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderTeam(){
  const content = document.getElementById('content');
  try {
    const team = await apiGet('/api/zonal/team');
    renderTeamPanel(team);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function renderTeamPanel(team){
  const groups = [
    { title: 'Head of Education', key: 'za_role_hoe', icon: 'shield-check' },
    { title: 'Teacher Development Coordinator', key: 'za_role_tdc', icon: 'user-cog' },
    { title: 'Supervisor', key: 'za_role_supervisor', icon: 'eye' }
  ];

  const sectionsHTML = groups.map(g => {
    const members = team.filter(m => m.title === g.title);
    const cardsHTML = members.length ? members.map(m => `
      <div class="team-card">
        <div class="team-card-avatar">${initialsOf(m.full_name)}</div>
        <div class="team-card-body">
          <div class="team-card-name">${m.full_name}</div>
          <div class="team-card-id">${m.admin_id}</div>
          ${m.zone_wide
            ? `<div class="team-card-schools"><i data-lucide="globe"></i><span>${t('za_team_zone_wide')}</span></div>`
            : `<div class="team-card-schools"><i data-lucide="building-2"></i><span>${m.schools.length ? m.schools.map(s=>schoolDisplayName(s.school_name, s.school_level)).join(', ') : t('za_team_no_schools')}</span></div>`
          }
        </div>
      </div>`).join('') : `<p class="hint">${t('za_team_group_empty')}</p>`;
    return `
    <div class="panel">
      <h3><i data-lucide="${g.icon}"></i> ${t(g.key)} <span class="team-group-count">${members.length}</span></h3>
      <div class="team-card-grid">${cardsHTML}</div>
    </div>`;
  }).join('');

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="users-round"></i> ${t('za_team_title')}</h3>
  </div>
  ${sectionsHTML}`;
  if (window.lucide) lucide.createIcons();
}

/* ==================================================================
   Subject Dictionary — adding/editing/removing subjects is the
   Development Coordinator's job (delegated or not — requireTdcOrHoe on
   the server, not requireCanActInZone). A Development Coordinator's
   add/edit lands as 'pending' and stays invisible to schools until the
   Head of Education approves it; the Head of Education's own add/edit
   is auto-approved. — live from:
     GET    /api/zonal/subject-dictionary   -> [{subject_dict_id, subject_name, status, ...}]
     POST   /api/zonal/subject-dictionary    body:{subject_name}
     PUT    /api/zonal/subject-dictionary/:id  body:{subject_name}
     POST   /api/zonal/subject-dictionary/:id/approve  (Head of Education only)
     POST   /api/zonal/subject-dictionary/:id/reject   (Head of Education only)
     DELETE /api/zonal/subject-dictionary/:subject_dict_id
   ================================================================== */
function subjectsSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="book-open"></i> ${t('za_subjects_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderSubjects(){
  const content = document.getElementById('content');
  try {
    const subjects = await apiGet('/api/zonal/subject-dictionary');
    renderSubjectsPanel(subjects);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function canActInZone(){
  return CURRENT_USER && (CURRENT_USER.title==='Head of Education' || (CURRENT_USER.title==='Teacher Development Coordinator' && CURRENT_USER.can_act_independently));
}

// Subject Dictionary uses its own, wider permission than the rest of
// this page's "direct authority" pages: any Development Coordinator
// (delegated or not) can add/edit/remove — only *approving* a pending
// entry is Head-of-Education-only.
function canManageSubjects(){
  return CURRENT_USER && (CURRENT_USER.title==='Head of Education' || CURRENT_USER.title==='Teacher Development Coordinator');
}
function isHoe(){
  return CURRENT_USER && CURRENT_USER.title==='Head of Education';
}

function renderSubjectsPanel(subjects){
  const manage = canManageSubjects();
  const rows = subjects.length ? subjects.map(s=>`
    <tr data-id="${s.subject_dict_id}">
      <td class="subjectNameCell">${s.subject_name}</td>
      <td>
        ${manage ? `<button class="btn sm" data-act="edit" data-id="${s.subject_dict_id}" data-name="${s.subject_name}">${t('za_edit')}</button>` : ''}
        ${manage ? `<button class="btn danger sm" data-act="delete" data-id="${s.subject_dict_id}">${t('za_delete')}</button>` : ''}
      </td>
    </tr>`).join('') : `<tr><td colspan="2" class="hint">${t('za_subjects_empty')}</td></tr>`;

  const formHTML = manage ? `
    <div class="form-grid">
      <div class="form-field">
        <label for="f_subj_name">${t('za_f_subject_name')}</label>
        <input type="text" id="f_subj_name" placeholder="e.g. Mathematics">
      </div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnSaveSubject">${t('za_save')}</button>
    </div>
    <p class="hint" id="subjectFormMsg"></p>` : `<p class="hint">${t('za_subjects_readonly_note')}</p>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="book-open"></i> ${t('za_subjects_title')}</h3>
    ${formHTML}
  </div>
  <div class="panel">
    <h3><i data-lucide="book-open"></i> ${t('za_subjects_list')}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t('za_f_subject_name')}</th><th>${t('za_th_action')}</th></tr>
      ${rows}
    </table></div>
  </div>`;
  if (window.lucide) lucide.createIcons();

  let editingId = null;

  if(manage){
    document.getElementById('btnSaveSubject').addEventListener('click', async ()=>{
      const msg = document.getElementById('subjectFormMsg');
      const subject_name = document.getElementById('f_subj_name').value.trim();
      if(!subject_name){ setErrorMsg(msg, t('za_subjects_required')); return; }
      try {
        const result = editingId
          ? await apiPut(`/api/zonal/subject-dictionary/${editingId}`, { subject_name })
          : await apiPost('/api/zonal/subject-dictionary', { subject_name });
        await loadAndRenderSubjects();
        const newMsg = document.getElementById('subjectFormMsg');
        if(newMsg) setSuccessMsg(newMsg, result.message);
      } catch (err) {
        setErrorMsg(msg, err.message);
      }
    });
    document.querySelectorAll('button[data-act="edit"]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        editingId = btn.dataset.id;
        document.getElementById('f_subj_name').value = btn.dataset.name;
        document.getElementById('btnSaveSubject').textContent = t('za_save_changes');
        document.getElementById('f_subj_name').focus();
      });
    });
    document.querySelectorAll('button[data-act="delete"]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        if(!(await showConfirm(t('za_subjects_delete_confirm')))) return;
        try {
          await apiDelete(`/api/zonal/subject-dictionary/${btn.dataset.id}`);
          loadAndRenderSubjects();
        } catch (err) {
          setErrorMsg(document.getElementById('subjectFormMsg'), err.message);
        }
      });
    });
  }
}

/* ==================================================================
   Recruitment (Teacher Development Coordinator) — live from:
     GET  /api/zonal/schools
     GET  /api/zonal/incoming-teachers   -> [{incoming_id, school_id,
          school_name, first_name, middle_name, last_name, status,
          teacher_id, decline_reason, created_at, decided_at}]
     GET  /api/zonal/proposals           -> includes pushed_at/pushed_by
     POST /api/zonal/proposals/:id/push  -> the final step for a proposal
          the Head of Education has already approved (hire_teacher,
          appoint_school_admin, transfer_teacher, assign_supervisor all
          go through this one action) — see the split of
          /api/zonal/proposals/:id/approve into approve + push on the
          server. A candidate never needs re-describing here since it
          was already described once in My Proposals. Every hire goes
          through that proposal -> approval -> push pipeline now, with
          no same-page shortcut that skips Head of Education approval —
          see My Proposals for where a candidate is actually submitted.
   ================================================================== */
function recruitmentSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="user-plus"></i> ${t('za_recruitment_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderRecruitment(){
  const content = document.getElementById('content');
  try {
    const [schools, incoming, proposals] = await Promise.all([
      apiGet('/api/zonal/schools'),
      apiGet('/api/zonal/incoming-teachers'),
      apiGet('/api/zonal/proposals')
    ]);
    // Rejected hire proposals never produce an incoming_teachers row (see
    // the hire_teacher branch of /api/zonal/proposals/:id/push — a push
    // only happens on approval), so they're invisible in `incoming`
    // above. Pull them in separately so a rejected candidate's name still
    // shows up here, with a way to push them again.
    const rejectedHires = proposals.filter(p => p.proposal_type === 'hire_teacher' && normStatus(p.status) === 'rejected');
    renderRecruitmentPanel(schools, incoming, rejectedHires, proposals);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

const INCOMING_STATUS_PILL = { pending:'warn', accepted:'ok', declined:'bad' };

// A Teacher Development Coordinator with direct-act authority (or the
// Head of Education) can push a candidate straight to a school here —
// no approval needed, so the form belongs on this page.
//
// A non-delegated Development Coordinator describes the candidate (or
// admin appointment / transfer / supervisor assignment) once in My
// Proposals. Once the Head of Education approves it, it lands in the
// "Ready to Push" table below for the Development Coordinator to push —
// the final step that actually creates the account, sends the transfer,
// or delivers the hire to the school. Making them fill out the same
// name/phone/email fields a second time here would be pure duplicate
// work, so this page never re-collects that information.
function renderRecruitmentPanel(schools, incoming, rejectedHires, proposals){
  const isTDC = CURRENT_USER.title === 'Teacher Development Coordinator';
  const schoolName = id => { const s = schools.find(s=>String(s.id)===String(id)); return s ? schoolDisplayName(s.school_name, s.school_level) : '—'; };

  // Approved by the Head of Education, not yet pushed — this is the
  // queue a Teacher Development Coordinator works from. Every hire now
  // goes through this proposal -> approval -> push pipeline, including
  // for a delegated ("direct-act") Development Coordinator — there's
  // no more same-page shortcut that skips Head of Education approval
  // (see My Proposals for where a candidate actually gets submitted).
  const readyToPush = (proposals||[]).filter(p => normStatus(p.status)==='approved' && !p.pushed_at)
    .sort((a,b)=> new Date(a.reviewed_at||a.created_at) - new Date(b.reviewed_at||b.created_at));

  const readyRows = readyToPush.length ? readyToPush.map(p=>`
    <tr data-proposal-id="${p.proposal_id}">
      <td>${proposalTypeLabel(p)}</td>
      <td>${proposalSubjectLine(p)}</td>
      <td>${p.proposal_type==='assign_supervisor' ? t('za_f_delegated_schools') : schoolName(p.school_id)}</td>
      <td><button class="btn primary sm" data-act="push-proposal" data-id="${p.proposal_id}">${t('za_th_push')}</button></td>
    </tr>`).join('') : `<tr><td colspan="4" class="hint">${t('za_recruitment_ready_empty')}</td></tr>`;

  const pushedRows = incoming.slice().sort((a,b)=> new Date(b.created_at)-new Date(a.created_at)).map(i=>`
    <tr>
      <td>${[i.first_name, i.middle_name, i.last_name].filter(Boolean).join(' ')}</td><td>${schoolDisplayName(i.school_name, i.school_level)}</td>
      <td><span class="pill ${INCOMING_STATUS_PILL[normStatus(i.status)]||'warn'}">${t('za_incoming_status_'+normStatus(i.status))}</span></td>
      <td>${fmtDate(i.created_at)}</td><td></td>
    </tr>`);
  // appoint_school_admin / assign_supervisor pushes create an account
  // directly rather than an incoming_teachers row, so they never show up
  // in `incoming` above — pull the completed ones in here so the
  // activity table still has a record of them.
  const completedNonTeacherRows = (proposals||[])
    .filter(p => p.pushed_at && (p.proposal_type==='appoint_school_admin' || p.proposal_type==='assign_supervisor'))
    .sort((a,b)=> new Date(b.pushed_at)-new Date(a.pushed_at))
    .map(p=>`
    <tr>
      <td>${proposalSubjectLine(p)}</td><td>${p.proposal_type==='assign_supervisor' ? t('za_f_delegated_schools') : schoolName(p.school_id)}</td>
      <td><span class="pill ok">${t('za_act_status_approved')}</span></td>
      <td>${fmtDate(p.pushed_at)}</td><td></td>
    </tr>`);
  // Rejected proposals: same table, candidate name from the proposal
  // payload (there's no incoming_teachers row to read it from), a
  // "Rejected" pill, and a Push-again button that resubmits a fresh
  // proposal with the same details for Head of Education to review again.
  const rejectedRows = rejectedHires.slice().sort((a,b)=> new Date(b.created_at)-new Date(a.created_at)).map(p=>`
    <tr data-proposal-id="${p.proposal_id}">
      <td>${proposalSubjectLine(p)}</td><td>${schoolName(p.school_id)}</td>
      <td><span class="pill bad">${t('za_act_status_rejected')}</span></td>
      <td>${fmtDate(p.created_at)}</td>
      <td><button class="btn sm" data-act="push-again" data-id="${p.proposal_id}">${t('za_recruitment_push_again')}</button></td>
    </tr>`);
  const allRows = [...pushedRows, ...completedNonTeacherRows, ...rejectedRows];
  const rows = allRows.length ? allRows.join('') : `<tr><td colspan="5" class="hint">${t('za_recruitment_empty')}</td></tr>`;

  const readyPanel = isTDC ? `
  <div class="panel">
    <h3><i data-lucide="send"></i> ${t('za_recruitment_ready_title')}</h3>
    <p class="hint" style="margin-bottom:14px;">${t('za_recruitment_ready_hint')}</p>
    <div class="table-wrap"><table>
      <tr><th>${t('za_th_type')}</th><th>${t('za_th_name')}</th><th>${t('za_th_school')}</th><th></th></tr>
      ${readyRows}
    </table></div>
    <p class="hint" id="pushMsg"></p>
  </div>` : '';

  document.getElementById('content').innerHTML = `
  ${readyPanel}
  <div class="panel">
    <h3><i data-lucide="clipboard-list"></i> ${t('za_recruitment_pushed_title')}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t('za_th_name')}</th><th>${t('za_th_school')}</th><th>${t('za_th_status')}</th><th>${t('za_th_pushed')}</th><th></th></tr>
      ${rows}
    </table></div>
  </div>`;
  if (window.lucide) lucide.createIcons();

  if(isTDC){
    document.querySelectorAll('button[data-act="push-proposal"]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        btn.disabled = true;
        const pushMsg = document.getElementById('pushMsg');
        try {
          const result = await apiPost(`/api/zonal/proposals/${btn.dataset.id}/push`);
          await loadAndRenderRecruitment();
          const newMsg = document.getElementById('pushMsg');
          if(newMsg) setSuccessMsg(newMsg, result.message);
          // Only assign_supervisor pushes create a brand-new login on the
          // spot (see /api/zonal/proposals/:id/push's `extra` payload) —
          // that's the one case where credentials exist for exactly this
          // moment and nowhere else, so it's the only one that gets the
          // popup rather than just the inline success message above.
          if(result.default_password){
            showCredentialsModal(result.id, result.default_password);
          }
        } catch (err) {
          btn.disabled = false;
          if(pushMsg) setErrorMsg(pushMsg, err.message);
        }
      });
    });
  }

  document.querySelectorAll('button[data-act="push-again"]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const proposal = rejectedHires.find(p => String(p.proposal_id) === String(btn.dataset.id));
      if(!proposal) return;
      const payload = proposal.payload || {};
      try {
        const result = await apiPost('/api/zonal/proposals', { proposal_type: 'hire_teacher', school_id: proposal.school_id, payload });
        await loadAndRenderRecruitment();
        const newMsg = document.getElementById('pushMsg');
        if(newMsg) setSuccessMsg(newMsg, result.message);
      } catch (err) {
        const msg = document.getElementById('pushMsg');
        if(msg) setErrorMsg(msg, err.message);
      }
    });
  });
}

/* ==================================================================
   My Proposals (Teacher Development Coordinator) — live from:
     GET  /api/zonal/proposals   (server scopes this to the caller's
          own submissions since their title isn't Head of Education)
     POST /api/zonal/proposals   body:{proposal_type:'hire_teacher'|
          'appoint_school_admin'|'transfer_teacher'|'assign_supervisor',
          school_id, payload} — assign_supervisor omits school_id and
          carries its schools as payload.school_ids instead (see the
          submit handler below and the server's own comment on this route).
   ================================================================== */
function myProposalsSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="file-pen-line"></i> ${t('za_my_proposals_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderMyProposals(){
  const content = document.getElementById('content');
  try {
    const [schools, proposals, admins, teachers] = await Promise.all([
      apiGet('/api/zonal/schools'),
      apiGet('/api/zonal/proposals'),
      apiGet('/api/zonal/admin-users'),
      apiGet('/api/zonal/teachers')
    ]);
    renderMyProposalsPanel(schools, proposals, admins, teachers.filter(t=>t.title==='Teacher'));
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

const PROPOSAL_STATUS_PILL = { pending:'warn', approved:'ok', rejected:'bad' };
const SCHOOL_ADMIN_TITLES = ['Principal','Academic VP','Admin VP'];

function myProposalTypeFieldsHTML(teachers){
  return `
    <div id="fields_hire_teacher">
      <div class="form-grid">
        <div class="form-field"><label for="mp_first">${t('za_f_first_name')}</label><input type="text" id="mp_first"></div>
        <div class="form-field"><label for="mp_middle">${t('za_f_middle_name')}</label><input type="text" id="mp_middle" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label for="mp_last">${t('za_f_last_name')}</label><input type="text" id="mp_last"></div>
        <div class="form-field">
          <label for="mp_sex">${t('za_f_sex')}</label>
          <select id="mp_sex">
            <option value="">${t('za_pick_option')}</option>
            <option value="Male">${t('za_sex_male')}</option>
            <option value="Female">${t('za_sex_female')}</option>
          </select>
        </div>
        <div class="form-field">
          <label for="mp_education_level">${t('za_f_education_level')}</label>
          <select id="mp_education_level">
            <option value="">${t('za_pick_option')}</option>
            <option value="TVET / College Diploma">${t('za_edu_tvet_diploma')}</option>
            <option value="Bachelor's Degree">${t('za_edu_bachelors')}</option>
            <option value="Master's Degree">${t('za_edu_masters')}</option>
            <option value="PhD / Doctoral Degree">${t('za_edu_phd')}</option>
          </select>
        </div>
        <div class="form-field"><label for="mp_phone">${t('za_f_candidate_phone')}</label><input type="text" id="mp_phone" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label for="mp_email">${t('za_f_candidate_email')}</label><input type="email" id="mp_email" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label for="mp_code">${t('za_f_recruitment_code')}</label><input type="text" id="mp_code" placeholder="${t('za_optional')}"></div>
      </div>
    </div>
    <div id="fields_appoint_school_admin" style="display:none;">
      <div class="form-grid">
        <div class="form-field"><label for="mp_a_first">${t('za_f_first_name')}</label><input type="text" id="mp_a_first"></div>
        <div class="form-field"><label for="mp_a_middle">${t('za_f_middle_name')}</label><input type="text" id="mp_a_middle" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label for="mp_a_last">${t('za_f_last_name')}</label><input type="text" id="mp_a_last"></div>
        <div class="form-field"><label for="mp_a_title">${t('za_f_admin_title')}</label>
          <select id="mp_a_title">${SCHOOL_ADMIN_TITLES.map(x=>`<option value="${x}">${teacherTitleLabel(x)}</option>`).join('')}</select>
        </div>
        <div class="form-field">
          <label for="mp_a_sex">${t('za_f_sex')}</label>
          <select id="mp_a_sex">
            <option value="">${t('za_pick_option')}</option>
            <option value="Male">${t('za_sex_male')}</option>
            <option value="Female">${t('za_sex_female')}</option>
          </select>
        </div>
        <div class="form-field">
          <label for="mp_a_education_level">${t('za_f_education_level')}</label>
          <select id="mp_a_education_level">
            <option value="">${t('za_pick_option')}</option>
            <option value="TVET / College Diploma">${t('za_edu_tvet_diploma')}</option>
            <option value="Bachelor's Degree">${t('za_edu_bachelors')}</option>
            <option value="Master's Degree">${t('za_edu_masters')}</option>
            <option value="PhD / Doctoral Degree">${t('za_edu_phd')}</option>
          </select>
        </div>
        <div class="form-field"><label for="mp_a_phone">${t('za_f_candidate_phone')}</label><input type="text" id="mp_a_phone" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label for="mp_a_email">${t('za_f_candidate_email')}</label><input type="email" id="mp_a_email" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label for="mp_a_password">${t('za_f_password')}</label><input type="password" id="mp_a_password"></div>
      </div>
      <div id="replaceAdminBox" style="display:none;margin-top:10px;padding:10px;border:1px solid var(--border,#333);border-radius:8px;">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" id="mp_a_replace_check">
          <span id="replaceAdminLabel"></span>
        </label>
      </div>
    </div>
    <div id="fields_transfer_teacher" style="display:none;">
      <p class="hint" style="margin-bottom:10px;">${t('za_transfer_hint')}</p>
      <div class="table-wrap" style="max-height:320px;overflow-y:auto;">
        <table>
          <thead><tr>
            <th></th><th>${t('za_th_teacher_id')}</th><th>${t('za_th_teacher')}</th><th>${t('za_th_school')}</th>
          </tr></thead>
          <tbody id="transferTeacherTbody">
            <tr><td colspan="4" class="hint">${t('za_transfer_pick_school_first')}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div id="fields_assign_supervisor" style="display:none;">
      <div class="form-grid">
        <div class="form-field"><label for="mp_s_first">${t('za_f_first_name')}</label><input type="text" id="mp_s_first"></div>
        <div class="form-field"><label for="mp_s_middle">${t('za_f_middle_name')}</label><input type="text" id="mp_s_middle" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label for="mp_s_last">${t('za_f_last_name')}</label><input type="text" id="mp_s_last"></div>
        <div class="form-field"><label for="mp_s_phone">${t('za_f_candidate_phone')}</label><input type="text" id="mp_s_phone" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label for="mp_s_email">${t('za_f_candidate_email')}</label><input type="email" id="mp_s_email" placeholder="${t('za_optional')}"></div>
      </div>
      <div class="form-field" style="margin-top:10px;">
        <label>${t('za_f_delegated_schools')}</label>
        <p class="hint" style="margin:4px 0 8px;">${t('za_supervisor_schools_hint')}</p>
        <div id="supervisorSchoolsList" class="checklist"></div>
      </div>
    </div>`;
}

// Populates the transfer-tab teacher table once a destination school is
// picked: every teacher NOT already at that school, each with a checkbox
// so more than one can be selected before submitting. Called on school
// change (see renderMyProposalsPanel) and re-called whenever the tab is
// switched to Transfer Teacher so it reflects whatever's already picked.
function renderTransferTeacherTable(teachers, destSchoolId){
  const tbody = document.getElementById('transferTeacherTbody');
  if (!tbody) return;
  if (!destSchoolId) {
    tbody.innerHTML = `<tr><td colspan="4" class="hint">${t('za_transfer_pick_school_first')}</td></tr>`;
    return;
  }
  const eligible = (teachers||[]).filter(tc => String(tc.school_id) !== String(destSchoolId));
  tbody.innerHTML = eligible.length ? eligible.map(tc=>`
    <tr>
      <td><input type="checkbox" class="transferTeacherCheck" value="${tc.teacher_id}" data-name="${tc.full_name}"></td>
      <td>${tc.teacher_id}</td>
      <td>${tc.full_name}</td>
      <td>${schoolDisplayName(tc.school_name, tc.school_level)}</td>
    </tr>`).join('') : `<tr><td colspan="4" class="hint">${t('za_transfer_none_eligible')}</td></tr>`;
}

// A school can only hold one Principal / one Academic VP / one Admin VP
// at a time in practice — so when a Development Coordinator picks a
// school + title that's already filled, this surfaces who's currently
// in that seat and lets them opt in to replacing that person. Purely
// client-side lookup against the admin roster already fetched for this
// page; nothing is sent to the server until the checkbox is ticked and
// the proposal is submitted with replace_admin_id in its payload.
function currentAdminFor(admins, school_id, title){
  return admins.find(a => String(a.school_id) === String(school_id) && a.title === title) || null;
}

function updateReplaceAdminBox(admins){
  const school_id = document.getElementById('mp_school').value;
  const title = document.getElementById('mp_a_title').value;
  const box = document.getElementById('replaceAdminBox');
  const label = document.getElementById('replaceAdminLabel');
  const check = document.getElementById('mp_a_replace_check');
  const existing = school_id ? currentAdminFor(admins, school_id, title) : null;
  if (existing) {
    box.style.display = '';
    label.textContent = t('za_replace_admin_question').replace('{name}', [existing.first_name, existing.middle_name, existing.last_name].filter(Boolean).join(' ')).replace('{title}', teacherTitleLabel(title));
    box.dataset.replaceId = existing.admin_id;
  } else {
    box.style.display = 'none';
    check.checked = false;
    box.dataset.replaceId = '';
  }
}

// Populates the supervisor-assignment checklist of every school in the
// zone, so a Development Coordinator can hand a Supervisor one or more
// schools in a single proposal — mirrors renderTransferTeacherTable's
// pattern, just without a destination-school gate since there's nothing
// to filter against yet.
function renderSupervisorSchoolsChecklist(schools){
  const list = document.getElementById('supervisorSchoolsList');
  if (!list) return;
  list.innerHTML = schools.length ? schools.map(s=>`
    <label class="checklist-row">
      <input type="checkbox" class="supervisorSchoolCheck" value="${s.id}">
      <span>${schoolDisplayName(s.school_name, s.school_level)}</span>
    </label>`).join('') : `<p class="hint">${t('za_no_schools')}</p>`;
}

function renderMyProposalsPanel(schools, proposals, admins, teachers){
  const schoolName = id => { const s = schools.find(s=>String(s.id)===String(id)); return s ? schoolDisplayName(s.school_name, s.school_level) : '—'; };
  const schoolOpts = schools.map(s=>`<option value="${s.id}">${schoolDisplayName(s.school_name, s.school_level)}</option>`).join('');

  const rows = proposals.length ? proposals.slice().sort((a,b)=> new Date(b.created_at)-new Date(a.created_at)).map(p=>`
    <tr>
      <td>${proposalTypeLabel(p)}</td><td>${proposalSubjectLine(p)}</td><td>${schoolName(p.school_id)}</td>
      <td><span class="pill ${PROPOSAL_STATUS_PILL[normStatus(p.status)]||'warn'}">${t('za_act_status_'+normStatus(p.status))}</span></td>
      <td>${fmtDate(p.created_at)}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="hint">${t('za_my_proposals_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="file-pen-line"></i> ${t('za_my_proposals_new')}</h3>
    <div class="tabs">
      <button class="tab-btn active" data-type="hire_teacher">${t('za_act_proposal_hire')}</button>
      <button class="tab-btn" data-type="appoint_school_admin">${t('za_act_proposal_admin')}</button>
      <button class="tab-btn" data-type="transfer_teacher">${t('za_act_proposal_transfer')}</button>
      <button class="tab-btn" data-type="assign_supervisor">${t('za_act_proposal_supervisor')}</button>
    </div>
    <div class="form-field" id="mp_school_wrap" style="max-width:320px;margin-bottom:14px;">
      <label id="mp_school_label" for="mp_school">${t('za_f_target_school')}</label>
      <select id="mp_school"><option value="">${t('za_pick_school')}</option>${schoolOpts}</select>
    </div>
    ${myProposalTypeFieldsHTML(teachers)}
    <div class="form-actions">
      <button class="btn primary" id="btnSubmitProposal">${t('za_my_proposals_submit')}</button>
    </div>
    <p class="hint" id="proposalFormMsg"></p>
  </div>
  <div class="panel">
    <h3><i data-lucide="clipboard-list"></i> ${t('za_my_proposals_title')}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t('za_th_type')}</th><th>${t('za_th_name')}</th><th>${t('za_th_school')}</th><th>${t('za_th_status')}</th><th>${t('za_th_submitted')}</th></tr>
      ${rows}
    </table></div>
  </div>`;

  let activeType = 'hire_teacher';
  renderSupervisorSchoolsChecklist(schools);
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      activeType = btn.dataset.type;
      document.getElementById('fields_hire_teacher').style.display = activeType==='hire_teacher' ? '' : 'none';
      document.getElementById('fields_appoint_school_admin').style.display = activeType==='appoint_school_admin' ? '' : 'none';
      document.getElementById('fields_transfer_teacher').style.display = activeType==='transfer_teacher' ? '' : 'none';
      document.getElementById('fields_assign_supervisor').style.display = activeType==='assign_supervisor' ? '' : 'none';
      // assign_supervisor picks its schools via the checklist above, not
      // the single mp_school selector every other proposal type uses.
      document.getElementById('mp_school_wrap').style.display = activeType==='assign_supervisor' ? 'none' : '';
      document.getElementById('mp_school_label').textContent = activeType==='transfer_teacher' ? t('za_f_destination_school') : t('za_f_target_school');
      if(activeType==='appoint_school_admin') updateReplaceAdminBox(admins);
      if(activeType==='transfer_teacher') renderTransferTeacherTable(teachers, document.getElementById('mp_school').value);
    });
  });

  // Whenever the target school or the admin title changes, re-check
  // whether that seat is already filled at that school. For the transfer
  // tab, re-filter the eligible-teachers table to whatever the newly
  // picked destination school excludes.
  document.getElementById('mp_school').addEventListener('change', (e)=>{
    if(activeType==='appoint_school_admin') updateReplaceAdminBox(admins);
    if(activeType==='transfer_teacher') renderTransferTeacherTable(teachers, e.target.value);
  });
  document.getElementById('mp_a_title').addEventListener('change', ()=> updateReplaceAdminBox(admins));

  document.getElementById('btnSubmitProposal').addEventListener('click', async ()=>{
    const msg = document.getElementById('proposalFormMsg');
    const school_id = document.getElementById('mp_school').value;
    if(activeType!=='assign_supervisor' && !school_id){ setErrorMsg(msg, t('za_pick_school')); return; }

    let payload, transferPayloads, supervisorSchoolIds;
    if(activeType==='hire_teacher'){
      const first_name = document.getElementById('mp_first').value.trim();
      const last_name = document.getElementById('mp_last').value.trim();
      if(!first_name || !last_name){ setErrorMsg(msg, t('za_recruitment_required')); return; }
      payload = {
        first_name, last_name,
        middle_name: document.getElementById('mp_middle').value.trim() || null,
        sex: document.getElementById('mp_sex').value || null,
        education_level: document.getElementById('mp_education_level').value || null,
        contact_number: document.getElementById('mp_phone').value.trim() || null,
        email: document.getElementById('mp_email').value.trim() || null,
        zonal_recruitment_code: document.getElementById('mp_code').value.trim() || null
      };
    } else if(activeType==='transfer_teacher'){
      const checked = Array.from(document.querySelectorAll('.transferTeacherCheck:checked'));
      if(!checked.length){ setErrorMsg(msg, t('za_transfer_pick_teachers')); return; }
      transferPayloads = checked.map(cb => ({ teacher_id: cb.value, teacher_name: cb.dataset.name }));
    } else if(activeType==='assign_supervisor'){
      const first_name = document.getElementById('mp_s_first').value.trim();
      const last_name = document.getElementById('mp_s_last').value.trim();
      supervisorSchoolIds = Array.from(document.querySelectorAll('.supervisorSchoolCheck:checked')).map(cb=>cb.value);
      if(!first_name || !last_name){ setErrorMsg(msg, t('za_my_proposals_admin_required')); return; }
      if(!supervisorSchoolIds.length){ setErrorMsg(msg, t('za_supervisor_pick_schools')); return; }
      payload = {
        first_name, last_name,
        middle_name: document.getElementById('mp_s_middle').value.trim() || null,
        contact_number: document.getElementById('mp_s_phone').value.trim() || null,
        email: document.getElementById('mp_s_email').value.trim() || null,
        school_ids: supervisorSchoolIds
      };
    } else {
      const first_name = document.getElementById('mp_a_first').value.trim();
      const last_name = document.getElementById('mp_a_last').value.trim();
      const password = document.getElementById('mp_a_password').value;
      if(!first_name || !last_name || !password){ setErrorMsg(msg, t('za_my_proposals_admin_required')); return; }
      const replaceBox = document.getElementById('replaceAdminBox');
      const wantsReplace = document.getElementById('mp_a_replace_check').checked;
      payload = {
        first_name, last_name, password,
        middle_name: document.getElementById('mp_a_middle').value.trim() || null,
        title: document.getElementById('mp_a_title').value,
        sex: document.getElementById('mp_a_sex').value || null,
        education_level: document.getElementById('mp_a_education_level').value || null,
        contact_number: document.getElementById('mp_a_phone').value.trim() || null,
        email: document.getElementById('mp_a_email').value.trim() || null,
        replace_admin_id: (wantsReplace && replaceBox.dataset.replaceId) ? replaceBox.dataset.replaceId : null
      };
    }

    try {
      let successText;
      if (activeType === 'transfer_teacher') {
        // One proposal per selected teacher — the backend's proposal
        // payload is single-teacher, so a multi-select submits several
        // proposals in parallel rather than inventing a batch payload
        // shape the approval side doesn't understand yet.
        await Promise.all(transferPayloads.map(payload =>
          apiPost('/api/zonal/proposals', { proposal_type: activeType, school_id, payload })
        ));
        successText = transferPayloads.length === 1
          ? t('za_transfer_proposal_submitted_one')
          : t('za_transfer_proposal_submitted_many').replace('{count}', transferPayloads.length);
      } else if (activeType === 'assign_supervisor') {
        // No top-level school_id for this type — the server derives it
        // from payload.school_ids[0] (see POST /api/zonal/proposals).
        const result = await apiPost('/api/zonal/proposals', { proposal_type: activeType, payload });
        successText = result.message;
      } else {
        const result = await apiPost('/api/zonal/proposals', { proposal_type: activeType, school_id, payload });
        successText = result.message;
      }
      // Reload FIRST (rebuilds #proposalFormMsg), then set the confirmation
      // text on the new element — otherwise the reload wipes the message
      // before the user ever sees it.
      await loadAndRenderMyProposals();
      const newMsg = document.getElementById('proposalFormMsg');
      if(newMsg) setSuccessMsg(newMsg, successText);
    } catch (err) {
      setErrorMsg(msg, err.message);
    }
  });
}

/* ==================================================================
   Signature & Seal (Head of Education / delegated-eligible Teacher
   Development Coordinator; Supervisor is blocked server-side) — live from:
     GET  /api/zonal/profile-documents  -> {signature_url, stamp_url}
     POST /api/zonal/upload-signature    multipart field name 'signature'
     POST /api/zonal/upload-stamp        multipart field name 'stamp'
   ================================================================== */
/* ==================================================================
   Profile Settings (Head of Education / Teacher Development
   Coordinator only — a Supervisor's nav never shows this page, per
   uploadZonalDocument's own 403 on the backend) — signature, seal
   (stamp), ID photo, and account settings (name / password) all in
   one place. Replaces the old standalone Signature & Seal page.
   ================================================================== */
function profileSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="file-signature"></i> ${t('za_profile_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderProfile(){
  const content = document.getElementById('content');
  try {
    const data = await apiGet('/api/zonal/profile-documents');
    renderProfilePanel(data);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function renderProfilePanel(data){
  const name = CURRENT_USER.admin_full_name || CURRENT_USER.user_id || '';
  // This is the everyday profile picture shown in the sidebar/topbar
  // (avatar_url) — deliberately NOT id_photo_url, which is the separate
  // photo reserved for the printed ID card (see the "ID Photo" box below
  // and My ID). Mirrors the same avatar_url/id_photo_url split used for
  // teachers and school admins.
  const photoBlock = data.avatar_url
    ? `<img class="identity-photo-img" src="${data.avatar_url}" alt="${name}">`
    : `<div class="identity-photo-placeholder">${initialsOf(name)}</div>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="badge"></i> ${t('za_identity_title')}</h3>
    <div class="identity-widget" style="margin-top:14px;">
      <div class="identity-photo">
        ${photoBlock}
        <div class="identity-photo-edit" id="btnUploadIdentityPhoto" title="${t('za_change_photo')}">
          <i data-lucide="camera"></i>
        </div>
        <input type="file" accept="image/*" id="f_identity_photo_file" style="display:none;">
      </div>
      <div class="identity-info">
        <div class="identity-name">${name}</div>
        <div class="identity-role">${t(ROLE_META[role].titleKey)}</div>
        <div class="identity-id">${t('za_identity_id_label')}: ${CURRENT_USER.user_id || '—'}</div>
      </div>
    </div>
    <p class="hint" id="identityMsg"></p>
  </div>
  <div class="panel">
    <h3><i data-lucide="file-signature"></i> ${t('za_profile_docs_title')}</h3>
    <p class="hint" style="margin-bottom:14px;">${t('za_signatures_hint')}</p>
    <div class="sig-grid">
      <div>
        <label for="f_sig_file" style="display:block;font-size:12px;font-weight:700;color:var(--text-dim);margin-bottom:8px;">${t('za_signature_label')}</label>
        <div class="upload-box">
          ${data.signature_url ? `<img src="${data.signature_url}" alt="signature">` : `<span class="hint">${t('za_no_signature')}</span>`}
          <input type="file" accept="image/*" id="f_sig_file" style="display:none;">
          <button class="btn ghost sm" id="btnUploadSig">${t('za_upload')}</button>
        </div>
      </div>
      <div>
        <label for="f_seal_file" style="display:block;font-size:12px;font-weight:700;color:var(--text-dim);margin-bottom:8px;">${t('za_seal_label')}</label>
        <div class="upload-box">
          ${data.stamp_url ? `<img src="${data.stamp_url}" alt="stamp">` : `<span class="hint">${t('za_no_seal')}</span>`}
          <input type="file" accept="image/*" id="f_seal_file" style="display:none;">
          <button class="btn ghost sm" id="btnUploadSeal">${t('za_upload')}</button>
        </div>
      </div>
      <div>
        <label for="f_idphoto_file" style="display:block;font-size:12px;font-weight:700;color:var(--text-dim);margin-bottom:8px;">${t('za_id_photo_label')}</label>
        <div class="upload-box">
          ${data.id_photo_url ? `<img src="${data.id_photo_url}" alt="id photo">` : `<span class="hint">${t('za_no_id_photo')}</span>`}
          <input type="file" accept="image/*" id="f_idphoto_file" style="display:none;">
          <button class="btn ghost sm" id="btnUploadIdPhoto">${t('za_upload')}</button>
        </div>
      </div>
    </div>
    <p class="hint" id="signatureMsg"></p>
  </div>
  <div class="panel">
    <h3><i data-lucide="settings"></i> ${t('za_account_settings_title')}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="f_acct_first">${t('za_first_name')}</label>
        <input type="text" id="f_acct_first" value="${(CURRENT_USER.admin_full_name||'').split(' ')[0]||''}">
      </div>
      <div class="form-field">
        <label for="f_acct_last">${t('za_last_name')}</label>
        <input type="text" id="f_acct_last" value="${(CURRENT_USER.admin_full_name||'').split(' ').slice(1).join(' ')||''}">
      </div>
    </div>
    <div class="form-actions" style="margin-bottom:22px;">
      <button class="btn primary" id="btnSaveName">${t('za_save')}</button>
    </div>
    <div class="form-grid">
      <div class="form-field">
        <label for="f_acct_curpw">${t('za_current_password')}</label>
        <input type="password" id="f_acct_curpw">
      </div>
      <div class="form-field">
        <label for="f_acct_newpw">${t('za_new_password')}</label>
        <input type="password" id="f_acct_newpw">
      </div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnSavePassword">${t('za_update_password')}</button>
    </div>
    <p class="hint" id="acctMsg"></p>
  </div>`;

  wireSignatureUpload('f_identity_photo_file', 'btnUploadIdentityPhoto', '/api/zonal/upload-avatar', 'avatar', 'identityMsg');
  wireSignatureUpload('f_sig_file', 'btnUploadSig', '/api/zonal/upload-signature', 'signature');
  wireSignatureUpload('f_seal_file', 'btnUploadSeal', '/api/zonal/upload-stamp', 'stamp');
  wireSignatureUpload('f_idphoto_file', 'btnUploadIdPhoto', '/api/zonal/upload-id-photo', 'id_photo');

  document.getElementById('btnSaveName').addEventListener('click', async ()=>{
    const acctMsg = document.getElementById('acctMsg');
    try {
      await apiPost('/api/zonal/account', {
        first_name: document.getElementById('f_acct_first').value.trim(),
        last_name: document.getElementById('f_acct_last').value.trim()
      });
      acctMsg.textContent = t('za_saved');
      const me = await apiGet('/api/me');
      CURRENT_USER = me;
      renderTopChrome();
      if(window.lucide) window.lucide.createIcons();
    } catch (err) { acctMsg.textContent = err.message; }
  });

  document.getElementById('btnSavePassword').addEventListener('click', async ()=>{
    const acctMsg = document.getElementById('acctMsg');
    const current_password = document.getElementById('f_acct_curpw').value;
    const new_password = document.getElementById('f_acct_newpw').value;
    if(!new_password){ acctMsg.textContent = t('za_new_password'); return; }
    try {
      await apiPost('/api/zonal/account', { current_password, new_password });
      acctMsg.textContent = t('za_saved');
      document.getElementById('f_acct_curpw').value = '';
      document.getElementById('f_acct_newpw').value = '';
    } catch (err) { acctMsg.textContent = err.message; }
  });
}

async function uploadZonalFile(path, fieldName, file){
  const form = new FormData();
  form.append(fieldName, file);
  const res = await fetch(API_BASE + path, { method: 'POST', credentials: 'include', body: form });
  if (res.status === 401) { handleUnauthorized(); throw new Error('Not logged in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function wireSignatureUpload(fileId, btnId, path, fieldName, msgId){
  const fileEl = document.getElementById(fileId);
  const btn = document.getElementById(btnId);
  const msg = document.getElementById(msgId || 'signatureMsg');
  btn.addEventListener('click', ()=> fileEl.click());
  fileEl.addEventListener('change', async ()=>{
    const file = fileEl.files[0];
    if(!file) return;
    if(file.size > 2*1024*1024){ msg.textContent = t('za_signature_too_large'); return; }
    try {
      await uploadZonalFile(path, fieldName, file);
      // Avatar changes also need to refresh the topbar/sidebar, which read
      // from CURRENT_USER rather than the profile page's own fetch.
      if (fieldName === 'avatar') {
        CURRENT_USER = await apiGet('/api/me');
        renderTopChrome();
        if (window.lucide) window.lucide.createIcons();
      }
      await loadAndRenderProfile();
      const newMsg = document.getElementById(msgId || 'signatureMsg');
      if(newMsg) newMsg.textContent = t('za_saved');
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

/* ==================================================================
   My ID — flip card (front/back), mirrors the school-admin/teacher
   portals' "My ID" design 1:1, backed by /api/zonal/id-card. A zonal
   admin isn't tied to one school, so the card reads their ZONE and
   TITLE (Head of Education / Teacher Development Coordinator /
   Supervisor) instead of a school name and fixed role label. Fetched
   once per page visit and re-rendered (not re-fetched) on language
   switch — only the static labels change, not the underlying data.
   ================================================================== */
let zonalIdCardData = null;

function myIdSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="credit-card"></i> ${t('za_myid_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderMyId(){
  const c = document.getElementById('content');
  if (zonalIdCardData) { c.innerHTML = myIdPanelHTML(); renderZonalIdCard(zonalIdCardData); return; }
  try {
    const data = await apiGet('/api/zonal/id-card');
    zonalIdCardData = data;
    c.innerHTML = myIdPanelHTML();
    renderZonalIdCard(data);
  } catch (err) {
    c.innerHTML = errorPanel(err);
  }
}

function myIdPanelHTML(){
  return `
  <div class="panel">
    <h3><i data-lucide="credit-card"></i> ${t('za_myid_title')}</h3>
    <p class="hint" style="margin-bottom:18px;">${t('za_myid_hint')}</p>

    <div id="idcard-error" style="display:none;color:var(--danger);font-size:0.9rem;margin-bottom:16px;"></div>

    <div class="idcard-wrap" id="idcard-wrap" style="display:none">
      <div class="idcard-scene">
        <div class="idcard-flipper" id="idcard-flipper">
          <div class="idcard-face idcard-front">
            <div class="idcard-front-top">
              <div class="idcard-front-top-content">
                <div class="idcard-logo-badge"><img src="/assets/images/gflag.jpg" alt=""></div>
                <div class="idcard-brand-text">
                  <div class="idcard-zone-line" id="idcard-zone-front">—</div>
                  <div class="idcard-brand-school">GAMBELLA CITY EDUC. OFFICE</div>
                </div>
              </div>
            </div>
            <div class="idcard-photo-ring">
              <img id="idcard-photo" src="" alt="" style="display:none"
                   onerror="this.style.display='none'; document.getElementById('idcard-photo-placeholder').style.display='flex';">
              <div id="idcard-photo-placeholder" class="idcard-photo-placeholder" aria-hidden="true">
                <svg width="46" height="46" viewBox="0 0 24 24" fill="#8a6d8a">
                  <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"/>
                </svg>
              </div>
            </div>
            <div class="idcard-front-bottom">
              <div class="idcard-name" id="idcard-name">—</div>
              <div class="idcard-role" id="idcard-title-role">—</div>
              <div class="idcard-detail-rows">
                <div class="idcard-detail-row">
                  <span class="idcard-detail-label">ADMIN ID</span><span id="idcard-admin-id">—</span>
                </div>
                <div class="idcard-detail-row">
                  <span class="idcard-detail-label">ZONE</span><span id="idcard-zone-name">—</span>
                </div>
                <div class="idcard-detail-row">
                  <span class="idcard-detail-label">VALID UNTIL</span><span id="idcard-valid-until">—</span>
                </div>
              </div>
            </div>
          </div>

          <div class="idcard-face idcard-back">
            <div class="idcard-back-header">
              <div class="idcard-back-header-content">
                <div class="idcard-logo-badge"><img src="/assets/images/gflag.jpg" alt=""></div>
                <div class="idcard-brand-text idcard-brand-text-dark">
                  <div class="idcard-zone-line" id="idcard-zone-back">—</div>
                  <div class="idcard-brand-school">GAMBELLA CITY EDUC. OFFICE</div>
                </div>
              </div>
            </div>
            <div class="idcard-back-body">
              <div class="idcard-contact-title">CONTACT INFORMATION</div>
              <div class="idcard-contact-row">
                <span class="idcard-contact-label">PHONE</span><span id="idcard-phone">—</span>
              </div>
              <div class="idcard-contact-row">
                <span class="idcard-contact-label">EMAIL</span><span id="idcard-email">—</span>
              </div>
              <div class="idcard-qrcode" id="idcard-qrcode" aria-hidden="true"></div>
              <div class="idcard-signature">
                <img id="idcard-hoe-signature" class="idcard-signature-img" src="" alt="" style="display:none">
                <div class="idcard-signature-line"></div>
                <div class="idcard-signature-label">HEAD OF EDUCATION</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="idcard-actions" id="idcard-actions" style="display:none">
      <button type="button" class="btn primary" onclick="flipIdCard()">${t('za_idcard_flip')}</button>
      <button type="button" class="btn" onclick="printIdCard()">${t('za_idcard_print')}</button>
    </div>
  </div>`;
}

function renderZonalIdCard(data){
  const wrap = document.getElementById('idcard-wrap');
  const actions = document.getElementById('idcard-actions');
  const errorEl = document.getElementById('idcard-error');
  if (!wrap) return;

  if (errorEl) errorEl.style.display = 'none';
  wrap.style.display = 'flex';
  if (actions) actions.style.display = 'flex';

  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  const zoneLabel = data.zone ? data.zone.toUpperCase() : '—';
  setText('idcard-zone-front', zoneLabel);
  setText('idcard-zone-back', zoneLabel);
  setText('idcard-zone-name', data.zone || '—');
  setText('idcard-name', data.full_name || '—');
  setText('idcard-admin-id', data.admin_id || '—');
  setText('idcard-title-role', data.title ? data.title.toUpperCase() : '—');
  setText('idcard-valid-until', data.valid_until || '—');
  setText('idcard-phone', data.contact_number || '—');
  setText('idcard-email', data.email || '—');

  // NOTE: data.avatar_url here is the id-card endpoint's own field, which
  // the server already resolves as id_photo_url || avatar_url — i.e. the
  // dedicated ID photo takes priority over the everyday profile photo.
  // Don't confuse this with CURRENT_USER.avatar_url used for the topbar.
  const photo = document.getElementById('idcard-photo');
  const placeholder = document.getElementById('idcard-photo-placeholder');
  if (data.avatar_url && photo) {
    photo.src = API_BASE + data.avatar_url;
    photo.alt = data.full_name ? `Photo of ${data.full_name}` : 'Admin photo';
    photo.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
  } else {
    if (photo) photo.style.display = 'none';
    if (placeholder) placeholder.style.display = 'flex';
  }

  const hoeSig = document.getElementById('idcard-hoe-signature');
  if (hoeSig) {
    if (data.hoe_signature_url) {
      hoeSig.src = API_BASE + data.hoe_signature_url;
      hoeSig.style.display = 'block';
    } else {
      hoeSig.style.display = 'none';
    }
  }

  renderIdCardQrCode(data.qr_payload || data.admin_id || '');
}

function renderIdCardQrCode(payload){
  const container = document.getElementById('idcard-qrcode');
  if (!container) return;
  container.innerHTML = '';
  if (typeof qrcode !== 'function' || !payload) return;
  const qr = qrcode(4, 'M');
  qr.addData(String(payload));
  qr.make();
  container.innerHTML = qr.createSvgTag(4, 2);
}

window.flipIdCard = () => {
  const flipper = document.getElementById('idcard-flipper');
  if (flipper) flipper.classList.toggle('idcard-flipped');
};

window.printIdCard = () => { window.print(); };

/* ==================================================================
   Teachers directory (all three titles) — live from
   /api/zonal/teachers, optionally filtered by ?school_id=.
   ================================================================== */
let teachersSchoolFilter = '';
let teachersSearchTerm = '';

// School-admin titles first (in seniority order), plain classroom
// teachers last — so the table reads as a consistent hierarchy per
// school instead of the incidental alphabetical-by-first-name order
// the API happens to return.
const TEACHER_TITLE_ORDER = ['Principal', 'Academic VP', 'Admin VP', 'Teacher'];
const TEACHER_TITLE_KEY = {
  'Principal': 'za_title_principal',
  'Academic VP': 'za_title_academic_vp',
  'Admin VP': 'za_title_admin_vp',
  'Teacher': 'za_th_teacher'
};
function teacherTitleLabel(title){
  const key = TEACHER_TITLE_KEY[title];
  return key ? t(key) : (title || t('za_th_teacher'));
}

// school_level is stored as 'PRIMARY SCHOOL' / 'SECONDARY SCHOOL' (all
// caps, matching the DB ENUM) — this renders it in each language's
// normal case (e.g. "Secondary School" in English) rather than showing
// the raw stored value to the person using the app.
function schoolLevelLabel(level){
  if(level === 'PRIMARY SCHOOL') return t('za_school_level_primary');
  if(level === 'SECONDARY SCHOOL') return t('za_school_level_secondary');
  return '';
}

// Every place a school is shown as read-only text (tables, dropdowns, ID
// cards, message threads, delegation checklists...) should read as one
// combined string, e.g. "Newland Secondary School" — not just "Newland".
// The Register/Edit School form is the one exception: it keeps name and
// level as two separate fields since they're independently editable
// there. school_level may be missing on data fetched before this schema
// change existed, so this degrades gracefully to just the name.
function schoolDisplayName(name, level){
  if(!name) return '—';
  const label = schoolLevelLabel(level);
  return label ? `${name} ${label}` : name;
}
function teacherTitleRank(title){
  const i = TEACHER_TITLE_ORDER.indexOf(title);
  return i === -1 ? TEACHER_TITLE_ORDER.length : i;
}

function teachersSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="graduation-cap"></i> ${t('za_teachers_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderTeachers(){
  const content = document.getElementById('content');
  try {
    const [schools, teachers] = await Promise.all([
      apiGet('/api/zonal/schools'),
      apiGet('/api/zonal/teachers', teachersSchoolFilter ? { school_id: teachersSchoolFilter } : undefined)
    ]);
    renderTeachersPanel(schools, teachers);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

// Unified staff directory — classroom teachers AND school admins
// (Principal / Admin VP / Academic VP) together, since a school admin
// is "a teacher" by general title and shares the same TCH ID sequence.
// title distinguishes the two: plain "Teacher" vs. the admin's actual
// title. Column order: photo, Teacher ID, name, school, title, contact,
// email — per spec. Sorted by school, then by title seniority (not the
// incidental first-name order the API returns), then by name. A search
// box above the table filters client-side across name/ID/school/phone/
// email as the user types, so switching schools isn't the only way to
// narrow the list.
function teacherSexLabel(sex){
  if(sex === 'Male') return t('za_sex_male');
  if(sex === 'Female') return t('za_sex_female');
  return '—';
}
const TEACHER_EDU_KEY = {
  'TVET / College Diploma': 'za_edu_tvet_diploma',
  "Bachelor's Degree": 'za_edu_bachelors',
  "Master's Degree": 'za_edu_masters',
  'PhD / Doctoral Degree': 'za_edu_phd'
};
function teacherEduLabel(level){
  const key = TEACHER_EDU_KEY[level];
  return key ? t(key) : (level || '—');
}

function renderTeachersPanel(schools, teachers){
  const schoolOpts = `<option value="">${t('za_teachers_all_schools')}</option>` +
    schools.map(s=>`<option value="${s.id}" ${String(s.id)===String(teachersSchoolFilter)?'selected':''}>${schoolDisplayName(s.school_name, s.school_level)}</option>`).join('');

  const sorted = teachers.slice().sort((a,b)=>
    a.school_name.localeCompare(b.school_name) ||
    (teacherTitleRank(a.title) - teacherTitleRank(b.title)) ||
    a.full_name.localeCompare(b.full_name));

  const avatarCell = tch => tch.avatar_url
    ? `<img class="avatar-thumb" src="${tch.avatar_url}" alt="">`
    : `<div class="avatar-thumb avatar-placeholder"><i data-lucide="user"></i></div>`;

  const matchesSearch = (tch, term) => !term || [
    tch.teacher_id, tch.full_name, schoolDisplayName(tch.school_name, tch.school_level), tch.title,
    tch.contact_number, tch.email
  ].some(v => v && String(v).toLowerCase().includes(term));

  function renderTotals(){
    // Counts everyone in this table — classroom teachers AND school admins
    // (Principal, VPs, etc.) — since school admins now have sex on file
    // too (see /api/zonal/teachers). A Principal you appoint shows up
    // here immediately instead of being invisible from every KPI.
    const total = sorted.length;
    const male = sorted.filter(tch => tch.sex === 'Male').length;
    const female = sorted.filter(tch => tch.sex === 'Female').length;
    return `
    <div class="totals-strip">
      <div class="totals-chip"><i data-lucide="users"></i><span>${t('za_teachers_total')}</span><b>${total}</b></div>
      <div class="totals-chip"><i data-lucide="user"></i><span>${t('za_teachers_male')}</span><b>${male}</b></div>
      <div class="totals-chip"><i data-lucide="user"></i><span>${t('za_teachers_female')}</span><b>${female}</b></div>
    </div>`;
  }

  function renderRows(){
    const term = teachersSearchTerm.trim().toLowerCase();
    const filtered = sorted.filter(tch => matchesSearch(tch, term));
    const rows = filtered.length ? filtered.map(tch=>`
      <tr>
        <td class="sticky-col">${avatarCell(tch)}</td>
        <td class="sticky-col sticky-col-2">${tch.teacher_id}</td>
        <td class="sticky-col sticky-col-3">${tch.full_name}</td>
        <td>${schoolDisplayName(tch.school_name, tch.school_level)}</td>
        <td>${teacherTitleLabel(tch.title)}</td>
        <td>${teacherSexLabel(tch.sex)}</td>
        <td>${teacherEduLabel(tch.education_level)}</td>
        <td>${tch.contact_number || '—'}</td>
        <td>${tch.email || '—'}</td>
        <td>${tch.is_active ? `<span class="pill ok">${t('za_status_active')}</span>` : `<span class="pill bad">${t('za_status_inactive')}</span>`}</td>
      </tr>`).join('') : `<tr><td colspan="10" class="hint">${term ? t('za_teachers_search_empty') : t('za_schools_empty')}</td></tr>`;
    const tbody = document.getElementById('teachersTbody');
    if (tbody) tbody.innerHTML = rows;
    if (window.lucide) lucide.createIcons();
  }

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="graduation-cap"></i> ${t('za_teachers_title')}</h3>
    ${renderTotals()}
    <div class="filters">
      <div class="search-box"><i data-lucide="search"></i><input type="text" id="teacherSearchBox" placeholder="${t('za_teachers_search_placeholder')}" value="${teachersSearchTerm}"></div>
      <select id="teacherSchoolFilter">${schoolOpts}</select>
      <button class="btn ghost" id="btnDownloadTeachersCsv">⬇ ${t('za_download_csv')}</button>
    </div>
    <div class="table-wrap sticky-head">
      <table class="sticky-col-table">
      <thead><tr>
        <th class="sticky-col">${t('za_th_photo')}</th>
        <th class="sticky-col sticky-col-2">${t('za_th_teacher_id')}</th>
        <th class="sticky-col sticky-col-3">${t('za_th_teacher')}</th>
        <th>${t('za_th_school')}</th>
        <th>${t('za_th_title')}</th>
        <th>${t('za_th_sex')}</th>
        <th>${t('za_th_education_level')}</th>
        <th>${t('za_th_contact')}</th>
        <th>${t('za_th_email')}</th>
        <th>${t('za_th_status')}</th>
      </tr></thead>
      <tbody id="teachersTbody"></tbody>
    </table></div>
  </div>`;
  renderRows();

  document.getElementById('teacherSearchBox').addEventListener('input', e=>{
    teachersSearchTerm = e.target.value;
    renderRows();
  });

  document.getElementById('teacherSchoolFilter').addEventListener('change', e=>{
    teachersSchoolFilter = e.target.value;
    document.getElementById('content').innerHTML = teachersSkeletonHTML();
    loadAndRenderTeachers();
  });

  document.getElementById('btnDownloadTeachersCsv').addEventListener('click', ()=>{
    const term = teachersSearchTerm.trim().toLowerCase();
    const filtered = sorted.filter(tch => matchesSearch(tch, term));
    const header = [t('za_th_teacher_id'), t('za_th_teacher'), t('za_th_school'), t('za_th_title'), t('za_th_sex'), t('za_th_education_level'), t('za_th_contact'), t('za_th_email'), t('za_th_status')];
    const lines = [header.map(csvEscape).join(',')];
    filtered.forEach(tch=>{
      lines.push([
        tch.teacher_id, tch.full_name, schoolDisplayName(tch.school_name, tch.school_level), teacherTitleLabel(tch.title),
        teacherSexLabel(tch.sex), teacherEduLabel(tch.education_level), tch.contact_number || '', tch.email || '',
        tch.is_active ? t('za_status_active') : t('za_status_inactive')
      ].map(csvEscape).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zone-teachers-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

/* ==================================================================
   Messaging — inbox/sent from admin_messages, School Admin <->
   zonal_admins side (live from /api/zonal/messages). All three
   titles get this nav item; replying/composing targets a specific
   school_admins account (school_id + recipient_id), via
   /api/zonal/messages/recipients.
   ================================================================== */
let msgBox = 'inbox';
let msgActiveId = null;
let msgComposeTarget = null; // { school_id, id, full_name } when composing fresh

function messagesSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="mail"></i> ${t('za_messages_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderMessages(){
  const content = document.getElementById('content');
  try {
    const [messages, recipients] = await Promise.all([
      apiGet('/api/zonal/messages', { box: msgBox }),
      apiGet('/api/zonal/messages/recipients')
    ]);
    renderMessagesPanel(messages, recipients);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function renderMessagesPanel(messages, recipients){
  if(msgActiveId && !messages.find(m=>String(m.message_id)===String(msgActiveId))) msgActiveId = null;
  const active = msgActiveId ? messages.find(m=>String(m.message_id)===String(msgActiveId)) : null;

  const listItems = messages.length ? messages.map(m=>`
    <div class="msg-list-item ${!m.is_read && msgBox==='inbox' ? 'unread':''} ${String(m.message_id)===String(msgActiveId)?'active':''}" data-id="${m.message_id}">
      <div class="ml-from">${msgBox==='sent' ? schoolDisplayName(m.school_name, m.school_level) : (m.sender_name || schoolDisplayName(m.school_name, m.school_level))}</div>
      <div class="ml-subject">${m.subject || t('za_messages_no_subject')}</div>
      <div class="ml-date">${fmtDate(m.sent_at)}</div>
    </div>`).join('') : `<p class="hint">${t('za_messages_empty')}</p>`;

  const recipientOpts = recipients.map(r=>`<option value="${r.school_id}|${r.id}">${r.full_name} — ${r.title?teacherTitleLabel(r.title):''}</option>`).join('');

  const detailHTML = msgComposeTarget !== null ? `
    <div class="msg-detail">
      <h4>${t('za_messages_compose')}</h4>
      <div class="form-field" style="margin:12px 0;">
        <label for="composeRecipient">${t('za_messages_to')}</label>
        <select id="composeRecipient">${recipientOpts}</select>
      </div>
      <div class="form-field" style="margin-bottom:12px;">
        <label for="composeSubject">${t('za_messages_subject')}</label>
        <input type="text" id="composeSubject">
      </div>
      <div class="msg-reply-box"><textarea id="composeBody" placeholder="${t('za_messages_body_placeholder')}"></textarea></div>
      <div class="form-actions" style="margin-top:10px;">
        <button class="btn primary" id="btnSendCompose">${t('za_messages_send')}</button>
        <button class="btn ghost" id="btnCancelCompose">${t('za_cancel')}</button>
      </div>
      <p class="hint" id="composeMsg"></p>
    </div>`
  : active ? `
    <div class="msg-detail">
      <div>
        <div style="font-weight:700;font-size:15px;">${active.subject || t('za_messages_no_subject')}</div>
        <div class="hint" style="margin-top:4px;">
          ${msgBox==='sent' ? t('za_messages_to')+': '+schoolDisplayName(active.school_name, active.school_level) : t('za_messages_from')+': '+(active.sender_name||schoolDisplayName(active.school_name, active.school_level))}
          &nbsp;·&nbsp; ${fmtDate(active.sent_at)}
        </div>
      </div>
      <div class="msg-detail-body">${active.body}</div>
      ${msgBox==='inbox' ? `
      <div class="msg-reply-box">
        <textarea id="replyBody" placeholder="${t('za_messages_reply_placeholder')}"></textarea>
        <div class="form-actions" style="margin-top:10px;">
          <button class="btn primary" id="btnSendReply">${t('za_messages_reply')}</button>
        </div>
        <p class="hint" id="replyMsg"></p>
      </div>` : ''}
    </div>`
  : `<div class="msg-detail"><p class="hint">${t('za_messages_select')}</p></div>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="mail"></i> ${t('za_messages_title')}</h3>
    <div class="tabs">
      <button class="tab-btn ${msgBox==='inbox'?'active':''}" data-box="inbox">${t('za_messages_inbox')}</button>
      <button class="tab-btn ${msgBox==='sent'?'active':''}" data-box="sent">${t('za_messages_sent')}</button>
      <button class="btn ghost sm" id="btnNewMessage" style="margin-left:auto;"><i data-lucide="pencil"></i> ${t('za_messages_compose')}</button>
    </div>
    <div class="msg-layout">
      <div class="msg-list">${listItems}</div>
      ${detailHTML}
    </div>
  </div>`;

  document.querySelectorAll('.tab-btn[data-box]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      msgBox = btn.dataset.box; msgActiveId = null; msgComposeTarget = null;
      document.getElementById('content').innerHTML = messagesSkeletonHTML();
      loadAndRenderMessages();
    });
  });
  document.getElementById('btnNewMessage').addEventListener('click', ()=>{
    msgComposeTarget = {}; msgActiveId = null;
    renderMessagesPanel(messages, recipients);
  });
  document.querySelectorAll('.msg-list-item[data-id]').forEach(el=>{
    el.addEventListener('click', async ()=>{
      msgComposeTarget = null;
      msgActiveId = el.dataset.id;
      if(msgBox==='inbox'){
        const m = messages.find(x=>String(x.message_id)===String(msgActiveId));
        if(m && !m.is_read){ try { await apiPost(`/api/zonal/messages/${msgActiveId}/read`); m.is_read = 1; } catch(e){} }
      }
      renderMessagesPanel(messages, recipients);
    });
  });

  const cancelBtn = document.getElementById('btnCancelCompose');
  if(cancelBtn) cancelBtn.addEventListener('click', ()=>{ msgComposeTarget = null; renderMessagesPanel(messages, recipients); });

  const sendComposeBtn = document.getElementById('btnSendCompose');
  if(sendComposeBtn) sendComposeBtn.addEventListener('click', async ()=>{
    const sel = document.getElementById('composeRecipient').value;
    const [school_id, recipient_id] = sel.split('|');
    const subject = document.getElementById('composeSubject').value.trim();
    const body = document.getElementById('composeBody').value.trim();
    const msgEl = document.getElementById('composeMsg');
    if(!body){ msgEl.textContent = t('za_messages_body_placeholder'); return; }
    try {
      await apiPost('/api/zonal/messages', { school_id, recipient_id, subject, body });
      msgComposeTarget = null; msgBox = 'sent'; msgActiveId = null;
      document.getElementById('content').innerHTML = messagesSkeletonHTML();
      loadAndRenderMessages();
    } catch (err) { msgEl.textContent = err.message; }
  });

  const sendReplyBtn = document.getElementById('btnSendReply');
  if(sendReplyBtn) sendReplyBtn.addEventListener('click', async ()=>{
    const body = document.getElementById('replyBody').value.trim();
    const msgEl = document.getElementById('replyMsg');
    if(!body || !active) return;
    try {
      await apiPost('/api/zonal/messages', { school_id: active.school_id, recipient_id: active.sender_id, subject: active.subject ? 'Re: '+active.subject : '', body });
      msgEl.textContent = t('za_saved');
      document.getElementById('replyBody').value = '';
    } catch (err) { msgEl.textContent = err.message; }
  });
}

/* ==================================================================
   Ethiopian calendar dashboard widget — client-side mirror of the
   same Julian-Day-Number conversion and holiday tables server.js
   uses (isEthiopianHoliday / toEthiopianDate). Shown on every title's
   dashboard: a small month grid (Ethiopian months, G.C. dates on
   click-through not needed) plus an upcoming-holidays list, each
   holiday labeled with both calendars per the portal-wide "Ethiopian
   first, G.C. in brackets" convention.
   ================================================================== */
const ETH_MONTH_KEYS = ['meskerem','tikimt','hidar','tahsas','tir','yekatit','megabit','miazia','ginbot','sene','hamle','nehase','pagume'];
const JD_EPOCH_OFFSET_AMETE_MIHRET = 1723856;

function gregorianToJdn(year, month, day){
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}
function jdnToGregorian(jdn){
  const d = new Date((jdn - 2440588) * 86400000);
  return d;
}
function toEthiopianDate(dateInput){
  const d = new Date(dateInput);
  const jdn = gregorianToJdn(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const r = (jdn - JD_EPOCH_OFFSET_AMETE_MIHRET) % 1461;
  const n = (r % 365) + 365 * Math.floor(r / 1460);
  const year = 4 * Math.floor((jdn - JD_EPOCH_OFFSET_AMETE_MIHRET) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460);
  const month = Math.floor(n / 30) + 1;
  const day = (n % 30) + 1;
  return { year, month, day, monthKey: ETH_MONTH_KEYS[month - 1] };
}
function ethiopianToGregorian(year, month, day){
  // Inverse of toEthiopianDate via the same JDN epoch offset.
  const n = (month - 1) * 30 + (day - 1);
  const yearBlock = Math.floor((year - 1) / 4);
  const yearInBlock = (year - 1) % 4;
  const jdn = JD_EPOCH_OFFSET_AMETE_MIHRET + yearBlock * 1461 + yearInBlock * 365 + n;
  return jdnToGregorian(jdn);
}
const ETH_FIXED_HOLIDAYS = [
  { md: [1, 1], key: 'enkutatash' },
  { md: [1, 17], key: 'meskel' },
  { md: [12, 13], key: 'buhe' },
  { md: [4, 29], key: 'genna' },
  { md: [5, 11], key: 'timkat' },
  { md: [6, 23], key: 'adwa' },
  { md: [8, 23], key: 'labor' },
  { md: [8, 27], key: 'patriots' },
  { md: [9, 20], key: 'derg' }
];
const ETH_MOVABLE_HOLIDAYS = {
  2026: [
    { md: [3, 20], key: 'eid_fitr' }, { md: [5, 27], key: 'eid_adha' },
    { md: [8, 26], key: 'mawlid' }, { md: [4, 3], key: 'good_friday' }, { md: [4, 5], key: 'fasika' }
  ],
  2027: [
    { md: [3, 9], key: 'eid_fitr' }, { md: [5, 16], key: 'eid_adha' },
    { md: [8, 15], key: 'mawlid' }, { md: [4, 30], key: 'good_friday' }, { md: [5, 2], key: 'fasika' }
  ]
};
function getEthiopianHoliday(date){
  const d = new Date(date);
  const ec = toEthiopianDate(d);
  const fixed = ETH_FIXED_HOLIDAYS.find(h=> h.md[0]===ec.month && h.md[1]===ec.day);
  if(fixed) return fixed.key;
  const movable = (ETH_MOVABLE_HOLIDAYS[d.getFullYear()]||[]).find(h=> h.md[0]===d.getMonth()+1 && h.md[1]===d.getDate());
  return movable ? movable.key : null;
}
// Islamic holidays follow the lunar Hijri calendar, so their Gregorian
// date each year is a projection, not a fixed conversion like the other
// entries — flagged "(tentative)" in the upcoming-holidays list.
const ETH_TENTATIVE_HOLIDAY_KEYS = ['eid_fitr', 'eid_adha', 'mawlid'];

function renderEthiopianCalendarWidget(){
  const today = new Date();
  const todayEc = toEthiopianDate(today);

  // Upcoming holidays: scan forward up to just over a year so holidays
  // that roll into the next Gregorian year (Genna, Timkat) still show,
  // capped at 6 rows.
  const upcoming = [];
  for(let i=0;i<400 && upcoming.length<6;i++){
    const d = new Date(today.getTime() + i*86400000);
    const key = getEthiopianHoliday(d);
    if(key){
      const daysAway = Math.round((d - today) / 86400000);
      upcoming.push({ key, gc: d, daysAway });
    }
  }
  const holidayRows = upcoming.length ? upcoming.map(h=>`
    <div class="cal-holiday-row">
      <span class="cal-holiday-date-badge">${h.gc.toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>
      <span class="cal-holiday-name">${t('holiday_'+h.key)}${ETH_TENTATIVE_HOLIDAY_KEYS.includes(h.key) ? ` <span class="cal-holiday-tentative">(${t('za_cal_tentative')})</span>` : ''}</span>
      <span class="cal-holiday-days">${h.daysAway === 1 ? t('za_cal_in_day') : t('za_cal_in_days', {n: h.daysAway})}</span>
    </div>`).join('') : `<p class="hint">${t('za_cal_no_upcoming')}</p>`;

  return `
  <div class="panel">
    <h3><i data-lucide="calendar-days"></i> ${t('za_cal_title')}</h3>
    <div class="cal-today-box">
      <span class="cal-today-big">${todayEc.day} ${t('eth_month_'+todayEc.monthKey)} ${todayEc.year}</span>
      <span class="cal-today-sub">${today.toLocaleDateString('en-US',{weekday:'long'})} · GC: ${today.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</span>
    </div>
    <div class="cal-upcoming-label">${t('za_cal_upcoming')}</div>
    <div class="cal-holiday-simple-list">
      ${holidayRows}
    </div>
  </div>`;
}
function reinjectCalendarWidget(){
  const holder = document.getElementById('calWidgetHolder');
  if(!holder) return;
  holder.outerHTML = `<div id="calWidgetHolder">${renderEthiopianCalendarWidget()}</div>`;
  if(window.lucide) window.lucide.createIcons();
}


function render(){
  // Guard against activePage pointing at a page this title's nav no
  // longer includes (e.g. Head of Education landing on Setup School
  // from a stale link) — fall back to the dashboard rather than
  // rendering a page with no matching nav entry.
  if(!navHasPage(activePage)) activePage = 'za_nav_dashboard';
  renderNav();
  renderTopChrome();
  const c = document.getElementById('content');
  if(activePage==='za_nav_dashboard') { c.innerHTML = dashboardSkeletonHTML(); loadAndRenderDashboard(); }
  else if(activePage==='za_nav_schools') { c.innerHTML = schoolsSkeletonHTML(); loadAndRenderSchools(); }
  else if(activePage==='za_nav_students') { c.innerHTML = studentsSkeletonHTML(); loadAndRenderStudents(); }
  else if(activePage==='za_nav_school_performance') { c.innerHTML = performanceSkeletonHTML(); loadAndRenderPerformance(); }
  else if(activePage==='za_nav_teachers') { c.innerHTML = teachersSkeletonHTML(); loadAndRenderTeachers(); }
  else if(activePage==='za_nav_setup_school') { c.innerHTML = setupSchoolSkeletonHTML(); loadAndRenderSetupSchool(); }
  else if(activePage==='za_nav_approvals') { c.innerHTML = approvalsSkeletonHTML(); loadAndRenderApprovals(); }
  else if(activePage==='za_nav_delegation') { c.innerHTML = delegationSkeletonHTML(); loadAndRenderDelegation(); }
  else if(activePage==='za_nav_team') { c.innerHTML = teamSkeletonHTML(); loadAndRenderTeam(); }
  else if(activePage==='za_nav_subjects') { c.innerHTML = subjectsSkeletonHTML(); loadAndRenderSubjects(); }
  else if(activePage==='za_nav_recruitment') { c.innerHTML = recruitmentSkeletonHTML(); loadAndRenderRecruitment(); }
  else if(activePage==='za_nav_proposals') { c.innerHTML = myProposalsSkeletonHTML(); loadAndRenderMyProposals(); }
  else if(activePage==='za_nav_profile') { c.innerHTML = profileSkeletonHTML(); loadAndRenderProfile(); }
  else if(activePage==='za_nav_myid') { c.innerHTML = myIdSkeletonHTML(); loadAndRenderMyId(); }
  else if(activePage==='za_nav_messages') { c.innerHTML = messagesSkeletonHTML(); loadAndRenderMessages(); }
  else c.innerHTML = genericPanel(activePage, 'file-text');
}

/* ---------------- Session bootstrap — GET /api/me -------------------- */
// guard.js has already bounced us to /login.html if the auth_token
// cookie is missing/invalid; this is what actually fills in who's
// logged in so the nav/top-bar/dashboard can be built for them.
async function loadCurrentUser(){
  const me = await apiGet('/api/me');
  if(me.role !== 'zonal_admins' || !TITLE_TO_ROLE_KEY[me.title]){
    // Wrong portal for this account, or a title guard.js's data-role
    // check can't see (e.g. no title assigned yet) — send them back.
    handleUnauthorized();
    throw new Error('Not a zonal admin account');
  }
  CURRENT_USER = me;
  role = TITLE_TO_ROLE_KEY[me.title];
}

/* ---------------- Notification bell — live from /api/notifications --- */
function renderNotifications(data){
  const dot = document.getElementById('notifDot');
  const list = document.getElementById('notifList');
  const count = data.unread_count || 0;
  if(count > 0){ dot.style.display = 'flex'; dot.textContent = count > 9 ? '9+' : String(count); }
  else { dot.style.display = 'none'; }

  list.innerHTML = (data.items && data.items.length)
    ? data.items.map(i=>`
        <div class="notif-item">
          <div class="n-subject">${i.subject}</div>
          <div class="n-meta">${i.reply_count} new — ${i.from}</div>
        </div>`).join('')
    : `<div class="notif-empty">${t('za_no_notifications')}</div>`;
}

async function loadNotifications(){
  try {
    const data = await apiGet('/api/notifications');
    renderNotifications(data);
  } catch (err) {
    // Non-critical — leave the bell as-is rather than breaking the page.
    console.error('notifications error:', err);
  }
}

function wireChrome(){
  const bell = document.getElementById('notifBell');
  const panel = document.getElementById('notifPanel');
  bell.addEventListener('click', (e)=>{
    e.stopPropagation();
    panel.classList.toggle('open');
  });
  document.addEventListener('click', ()=> panel.classList.remove('open'));
  panel.addEventListener('click', e=> e.stopPropagation());

  document.getElementById('logoutBtn').addEventListener('click', async ()=>{
    if(!(await showConfirm(t('za_logout_confirm')))) return;
    try { await apiPost('/api/logout'); } catch (err) { /* clearing the cookie server-side is best-effort; redirect regardless */ }
    window.location.href = '/login.html';
  });

  document.getElementById('navOpenBtn').addEventListener('click', openMobileNav);
  document.getElementById('navCloseBtn').addEventListener('click', closeMobileNav);
  document.getElementById('navOverlay').addEventListener('click', closeMobileNav);

  loadNotifications();
  setInterval(loadNotifications, 60000);
}

// Lucide icons are just <i data-lucide="..."> placeholders until
// lucide.createIcons() swaps them for real SVGs — rather than calling
// that after every single render*/load* function in this file (there
// are dozens), one MutationObserver on the whole document handles it:
// any DOM change (nav re-render, panel swap, modal open) gets new
// icons drawn automatically. createIcons() only touches elements that
// still have the data-lucide attribute, so repeat calls are cheap.
let lucideRaf = null;
function scheduleLucideRender(){
  if(lucideRaf) return;
  lucideRaf = requestAnimationFrame(()=>{
    lucideRaf = null;
    if(window.lucide) window.lucide.createIcons();
  });
}
new MutationObserver(scheduleLucideRender).observe(document.body, { childList: true, subtree: true });

async function boot(){
  try {
    await loadCurrentUser();
  } catch (err) {
    return; // loadCurrentUser already redirected to /login.html
  }
  wireChrome();
  render();
  scheduleLucideRender();
}

// i18n.js calls applyTranslations() on DOMContentLoaded for static
// [data-i18n] elements, and window.onSisLangChange() (if defined) after
// every setLang() call so dynamically-built content re-renders too.
window.onSisLangChange = ()=>{ if(CURRENT_USER) render(); };
document.addEventListener('DOMContentLoaded', boot);