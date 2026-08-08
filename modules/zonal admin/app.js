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

/* ---------------------------------------------------------------- */

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
    {sec:"za_sec_oversight", items:[["za_nav_school_performance","bar-chart-3"],["za_nav_messages","mail"],["za_nav_myid","credit-card"],["za_nav_profile","file-signature"]]}
  ],
  tdc:[
    {sec:"za_sec_admin", items:[
      ["za_nav_dashboard","home"],["za_nav_schools","building-2"],["za_nav_setup_school","plus-circle"],
      ["za_nav_recruitment","user-plus"],["za_nav_proposals","clipboard-list"]
    ]},
    {sec:"za_sec_academic", items:[["za_nav_subjects","book-open"],["za_nav_students","users"],["za_nav_teachers","graduation-cap"]]},
    {sec:"za_sec_oversight", items:[["za_nav_school_performance","bar-chart-3"],["za_nav_messages","mail"],["za_nav_myid","credit-card"],["za_nav_profile","file-signature"]]}
  ],
  supervisor:[
    {sec:"za_sec_admin", items:[["za_nav_dashboard","home"],["za_nav_schools","building-2"],["za_nav_teachers","graduation-cap"]]},
    {sec:"za_sec_oversight", items:[["za_nav_school_performance","bar-chart-3"],["za_nav_messages","mail"],["za_nav_myid","credit-card"]]}
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

function renderTopChrome(){
  const meta = ROLE_META[role];
  const name = CURRENT_USER.admin_full_name || CURRENT_USER.user_id;
  document.getElementById('roleIcon').innerHTML = `<i data-lucide="${meta.icon}"></i>`;
  document.getElementById('roleTitleTxt').textContent = t(meta.titleKey);
  document.getElementById('roleIdTxt').textContent = CURRENT_USER.user_id;
  document.getElementById('whoName').textContent = name;
  document.getElementById('whoRole').textContent = t(meta.titleKey);
  document.getElementById('avatarInit').textContent = initialsOf(name);
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
  return `<div class="panel"><p class="hint">${t('za_loading')}</p></div>`;
}

function fmtDate(d){
  if(!d) return '—';
  return new Date(d).toLocaleDateString(getCurrentLang()==='am' ? 'am-ET' : 'en-US', { year:'numeric', month:'short', day:'numeric' });
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
    content.innerHTML = errorPanel(err);
  }
}

function proposalActivityLine(p, schoolName){
  const label = p.proposal_type==='hire_teacher' ? t('za_act_proposal_hire') : t('za_act_proposal_admin');
  const status = normStatus(p.status);
  const statusKey = status==='pending' ? 'za_act_status_pending' : status==='approved' ? 'za_act_status_approved' : 'za_act_status_rejected';
  return { school: schoolName || '—', event: `${label} — ${t(statusKey)}`, date: p.reviewed_at || p.created_at };
}

function incomingActivityLine(i){
  const status = normStatus(i.status);
  const key = status==='pending' ? 'za_act_teacher_pushed' : status==='accepted' ? 'za_act_teacher_accepted' : 'za_act_teacher_declined';
  return { school: i.school_name, event: t(key), date: i.decided_at || i.created_at };
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

    const schoolName = id => (schools.find(s=>String(s.id)===String(id)) || {}).school_name;
    activity = [
      ...proposals.map(p=>proposalActivityLine(p, schoolName(p.school_id))),
      ...incoming.map(incomingActivityLine)
    ].sort((a,b)=> new Date(b.date) - new Date(a.date)).slice(0, 6);
  } else {
    const flagged = performance.filter(p=>p.needs_followup);
    cards += `
    <div class="card alert">
      <div class="icon"><i data-lucide="alert-triangle"></i></div>
      <div><div class="label">${t('za_flagged_teachers')}</div>
      <div class="value">${flagged.length}</div></div>
    </div>`;

    const schoolName = id => (schools.find(s=>String(s.id)===String(id)) || {}).school_name;
    activity = flagged
      .sort((a,b)=> (b.days_since_marks_upload ?? 9999) - (a.days_since_marks_upload ?? 9999))
      .slice(0, 6)
      .map(p=>({
        school: schoolName(p.school_id),
        event: `${p.full_name} — ${p.days_since_marks_upload!=null ? t('za_act_needs_followup', { days: p.days_since_marks_upload }) : t('za_act_no_marks_yet')}`,
        date: p.last_marks_upload
      }));
  }

  const activityRows = activity.length
    ? activity.map(a=>`<tr><td>${a.school}</td><td>${a.event}</td><td>${fmtDate(a.date)}</td></tr>`).join('')
    : `<tr><td colspan="3" class="hint">${t('za_activity_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
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
  </div>
  <div id="calWidgetHolder">${renderEthiopianCalendarWidget()}</div>`;
  wireEthiopianCalendarWidget();
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

  const schoolOpts = schools.map(s=>`<option value="${s.id}" ${String(filters.school_id)===String(s.id)?'selected':''}>${s.school_name}</option>`).join('');
  const classOpts = ['9','10','11','12'].map(c=>`<option value="${c}" ${filters.class_level===c?'selected':''}>${t('za_grade_short',{level:c})}</option>`).join('');
  const streamOpts = ['General','Natural','Social'].map(s=>`<option value="${s}" ${filters.stream===s?'selected':''}>${streamLabel(s)}</option>`).join('');
  const sectionOpts = ['A','B','C','D'].map(s=>`<option value="${s}" ${filters.section===s?'selected':''}>${s}</option>`).join('');
  const STATUS_VALUES = ['Active','Graduated','Dropped','Transferred - Pending','Transferred - Completed'];
  const statusOpts = STATUS_VALUES.map(s=>`<option value="${s}" ${filters.status===s?'selected':''}>${studentStatusLabel(s)}</option>`).join('');
  const yearOpts = years.map(y=>`<option value="${y}" ${String(filters.enrollment_year)===String(y)?'selected':''}>${y}</option>`).join('');

  const tableRows = rows.length ? rows.map(r=>`
    <tr>
      <td>${r.student_id}</td><td>${r.full_name}</td><td>${t('za_grade_short',{level:r.class_level})}</td>
      <td>${streamLabel(r.stream)}</td><td>${r.section || '—'}</td><td>${r.enrollment_year || '—'}</td>
      <td>${studentStatusPill(r.status)}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="hint">${t('za_students_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="users"></i> ${t('za_students_title')}</h3>
    <p class="hint" style="margin-bottom:14px;">${t('za_students_hint')}</p>
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
  const schoolName = id => (currentStudentSchools.find(s=>String(s.id)===String(id)) || {}).school_name || '';
  const header = ['School', t('za_th_id'), t('za_th_name'), t('za_th_class'), t('za_th_stream'), t('za_th_section'), t('za_th_enroll_year'), t('za_th_status')];
  const lines = [header.map(csvEscape).join(',')];
  currentStudentRows.forEach(r=>{
    lines.push([
      schoolName(r.school_id), r.student_id, r.full_name, t('za_grade_short',{level:r.class_level}),
      r.stream || '', r.section || '', r.enrollment_year || '', studentStatusLabel(r.status)
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
        <div class="psr-name">${r.school_name}</div>
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
    const teacherRow = t => `<div class="perf-issue-row"><span>${t.full_name}</span><span>${t.attendance_rate!=null ? t.attendance_rate+'%' : '—'}</span></div>`;
    const marksRow = t => `<div class="perf-issue-row"><span>${t.full_name}</span><span>${t.days_since_marks_upload!=null ? t.days_since_marks_upload+'d' : t('za_no_uploads_yet')}</span></div>`;
    const gapRow = g => `<div class="perf-issue-row"><span>${t('za_grade_short',{level:g.class_level})}-${g.section}${g.stream? ' ('+g.stream+')':''}</span><span>${t('za_perf_no_teacher')}</span></div>`;

    backdrop.querySelector('.perf-modal').innerHTML = `
      <button class="perf-modal-close" id="perfModalClose"><i data-lucide="x"></i></button>
      <h3 style="margin-bottom:4px;">${d.school_name}</h3>
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
    <p class="hint" style="margin-bottom:16px;">${t('za_setup_hint')}</p>
    <div class="form-grid">
      <div class="form-field">
        <label>${t('za_f_school_name')}</label>
        <input type="text" id="f_name" placeholder="e.g. Newland Secondary School">
      </div>
      <div class="form-field">
        <label>${t('za_f_school_prefix')}</label>
        <input type="text" id="f_prefix" placeholder="e.g. NLS">
      </div>
      <div class="form-field">
        <label>${t('za_f_moe_code')}</label>
        <input type="text" id="f_moe" placeholder="e.g. 1203010102">
      </div>
      <div class="form-field">
        <label>${t('za_f_region')}</label>
        <select id="f_region"><option value="">${t('za_pick_region')}</option>${regionOpts}</select>
      </div>
      <div class="form-field">
        <label>${t('za_f_zone')}</label>
        <select id="f_zone" disabled><option value="">${t('za_pick_zone')}</option></select>
      </div>
      <div class="form-field">
        <label>${t('za_f_woreda')}</label>
        <select id="f_woreda" disabled><option value="">${t('za_pick_woreda')}</option></select>
      </div>
      <div class="form-field">
        <label>${t('za_f_kebele')}</label>
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

  document.getElementById('btnCancelSchool').onclick = ()=>{ activePage='za_nav_dashboard'; render(); };
  document.getElementById('btnSaveSchool').onclick = submitNewSchool;
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
    } catch (err) { document.getElementById('setupFormMsg').textContent = '⚠️ ' + err.message; }
  });

  zoneEl.addEventListener('change', async ()=>{
    fillSelect(woredaEl, [], 'woreda_id', 'woreda_name', t('za_pick_woreda')); woredaEl.disabled = true;
    fillSelect(kebeleEl, [], 'kebele_id', 'kebele_name', t('za_pick_kebele')); kebeleEl.disabled = true;
    if(!zoneEl.value) return;
    try {
      const woredas = await apiGet('/api/zonal/lookup/woredas', { zone_id: zoneEl.value });
      fillSelect(woredaEl, woredas, 'woreda_id', 'woreda_name', t('za_pick_woreda'));
      woredaEl.disabled = woredas.length===0;
    } catch (err) { document.getElementById('setupFormMsg').textContent = '⚠️ ' + err.message; }
  });

  woredaEl.addEventListener('change', async ()=>{
    fillSelect(kebeleEl, [], 'kebele_id', 'kebele_name', t('za_pick_kebele')); kebeleEl.disabled = true;
    if(!woredaEl.value) return;
    try {
      const kebeles = await apiGet('/api/zonal/lookup/kebeles', { woreda_id: woredaEl.value });
      fillSelect(kebeleEl, kebeles, 'kebele_id', 'kebele_name', t('za_pick_kebele'));
      kebeleEl.disabled = kebeles.length===0;
    } catch (err) { document.getElementById('setupFormMsg').textContent = '⚠️ ' + err.message; }
  });
}

async function submitNewSchool(){
  const msg = document.getElementById('setupFormMsg');
  const body = {
    school_name: document.getElementById('f_name').value.trim(),
    school_prefix: document.getElementById('f_prefix').value.trim(),
    moe_school_code: document.getElementById('f_moe').value.trim() || null,
    region_id: document.getElementById('f_region').value || null,
    woreda_id: document.getElementById('f_woreda').value || null,
    kebele_id: document.getElementById('f_kebele').value || null
  };
  if(!body.school_name || !body.school_prefix){
    msg.textContent = '⚠️ ' + t('za_setup_required');
    return;
  }
  try {
    const result = await apiPost('/api/zonal/schools', body);
    msg.textContent = '✅ ' + result.message;
  } catch (err) {
    msg.textContent = '⚠️ ' + err.message;
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
      <td>${s.school_name}</td><td>${s.school_prefix || '—'}</td><td>${s.moe_school_code || '—'}</td>
      <td>${s.woreda || '—'}</td><td>${s.region || '—'}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="hint">${t('za_schools_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="building-2"></i> ${t('za_schools_title')}</h3>
    <p class="hint" style="margin-bottom:14px;">${t(role==='supervisor' ? 'za_schools_hint_supervisor' : 'za_schools_hint')}</p>
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
  return p.proposal_type==='hire_teacher' ? t('za_act_proposal_hire') : t('za_act_proposal_admin');
}

function proposalSubjectLine(p){
  const payload = p.payload || {};
  const name = [payload.first_name, payload.last_name].filter(Boolean).join(' ');
  return name || '—';
}

function renderApprovalsPanel(schools, proposals){
  const schoolName = id => (schools.find(s=>String(s.id)===String(id)) || {}).school_name || '—';
  const pending = proposals.filter(p=>normStatus(p.status)==='pending');
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
    <p class="hint" style="margin-bottom:14px;">${t('za_approvals_hint')}</p>
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
        successText = '✅ ' + result.message;
      } else {
        const reason = prompt(t('sa_prompt_rejection_reason')) || '';
        await apiPost(`/api/zonal/proposals/${id}/reject`, { reason });
        successText = '✅ ' + t('za_proposal_rejected');
      }
      // Reload FIRST (this rebuilds #approvalsMsg from scratch), then set
      // the confirmation text on the freshly-rendered element — otherwise
      // the reload wipes the message before the user ever sees it.
      await loadAndRenderApprovals();
      const msg = document.getElementById('approvalsMsg');
      if(msg) msg.textContent = successText;
    } catch (err) {
      const msg = document.getElementById('approvalsMsg');
      if(msg) msg.textContent = '⚠️ ' + err.message;
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
    <p class="hint" style="margin-bottom:8px;">${t('za_delegation_hint')}</p>
    <div id="delegationList">${rows}</div>
    <p class="hint" id="delegationMsg"></p>
  </div>`;

  document.querySelectorAll('.delegateToggle').forEach(toggle=>{
    toggle.addEventListener('change', async ()=>{
      try {
        const result = await apiPost(`/api/zonal/teamleader/${toggle.dataset.id}/delegate`, { can_act_independently: toggle.checked });
        await loadAndRenderDelegation();
        const newMsg = document.getElementById('delegationMsg');
        if(newMsg) newMsg.textContent = '✅ ' + result.message;
      } catch (err) {
        toggle.checked = !toggle.checked;
        const msg = document.getElementById('delegationMsg');
        if(msg) msg.textContent = '⚠️ ' + err.message;
      }
    });
  });
}

/* ==================================================================
   Subject Dictionary (HoE + TDC view; add/delete restricted to HoE or
   a delegated TDC — server enforces this via requireCanActInZone, the
   UI just hides the form for anyone it would 403 on) — live from:
     GET    /api/zonal/subject-dictionary   -> [{subject_dict_id, subject_name}]
     POST   /api/zonal/subject-dictionary    body:{subject_name}
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

function renderSubjectsPanel(subjects){
  const rows = subjects.length ? subjects.map(s=>`
    <tr data-id="${s.subject_dict_id}">
      <td>${s.subject_name}</td>
      <td>${canActInZone() ? `<button class="btn danger sm" data-act="delete" data-id="${s.subject_dict_id}">${t('za_delete')}</button>` : ''}</td>
    </tr>`).join('') : `<tr><td colspan="2" class="hint">${t('za_subjects_empty')}</td></tr>`;

  const formHTML = canActInZone() ? `
    <div class="form-grid">
      <div class="form-field">
        <label>${t('za_f_subject_name')}</label>
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
    <p class="hint" style="margin-bottom:14px;">${t('za_subjects_hint')}</p>
    ${formHTML}
  </div>
  <div class="panel">
    <h3><i data-lucide="book-open"></i> ${t('za_subjects_list')}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t('za_f_subject_name')}</th><th>${t('za_th_action')}</th></tr>
      ${rows}
    </table></div>
  </div>`;

  if(canActInZone()){
    document.getElementById('btnSaveSubject').addEventListener('click', async ()=>{
      const msg = document.getElementById('subjectFormMsg');
      const subject_name = document.getElementById('f_subj_name').value.trim();
      if(!subject_name){ msg.textContent = '⚠️ ' + t('za_subjects_required'); return; }
      try {
        await apiPost('/api/zonal/subject-dictionary', { subject_name });
        loadAndRenderSubjects();
      } catch (err) {
        msg.textContent = '⚠️ ' + err.message;
      }
    });
    document.querySelectorAll('button[data-act="delete"]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        if(!(await showConfirm(t('za_subjects_delete_confirm')))) return;
        try {
          await apiDelete(`/api/zonal/subject-dictionary/${btn.dataset.id}`);
          loadAndRenderSubjects();
        } catch (err) {
          document.getElementById('subjectFormMsg').textContent = '⚠️ ' + err.message;
        }
      });
    });
  }
}

/* ==================================================================
   Teacher Recruitment (Teacher Development Coordinator) — live from:
     GET  /api/zonal/schools
     GET  /api/zonal/incoming-teachers   -> [{incoming_id, school_id,
          school_name, first_name, middle_name, last_name, status,
          teacher_id, decline_reason, created_at, decided_at}]
     POST /api/zonal/teachers             body:{school_id, first_name,
          middle_name, last_name, contact_number, email, zonal_recruitment_code}
          — only works if canActInZone(); otherwise this pushes as a
          proposal instead (POST /api/zonal/proposals, proposal_type
          'hire_teacher') which only reaches the school once the Head
          of Education approves it.
   ================================================================== */
function recruitmentSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="user-plus"></i> ${t('za_recruitment_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderRecruitment(){
  const content = document.getElementById('content');
  try {
    const [schools, incoming] = await Promise.all([
      apiGet('/api/zonal/schools'),
      apiGet('/api/zonal/incoming-teachers')
    ]);
    renderRecruitmentPanel(schools, incoming);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

const INCOMING_STATUS_PILL = { pending:'warn', accepted:'ok', declined:'bad' };

// A Teacher Development Coordinator with direct-act authority (or the
// Head of Education) can push a candidate straight to a school here —
// no approval needed, so the form belongs on this page.
//
// A non-delegated Development Coordinator, on the other hand, already
// describes the candidate once in My Proposals. The moment the Head of
// Education approves that proposal, the server pushes it to the school
// automatically (see the hire_teacher branch of
// /api/zonal/proposals/:id/approve) — there's no second "push" action
// left for them to take. Making them fill out the same name/phone/email
// fields a second time here was pure duplicate work, so for this group
// the page is now a read-only tracker: it just lists what they've sent,
// whether that arrived via a direct push or an approved proposal.
function renderRecruitmentPanel(schools, incoming){
  const schoolOpts = schools.map(s=>`<option value="${s.id}">${s.school_name}</option>`).join('');
  const direct = canActInZone();

  const rows = incoming.length ? incoming.slice().sort((a,b)=> new Date(b.created_at)-new Date(a.created_at)).map(i=>`
    <tr>
      <td>${[i.first_name, i.middle_name, i.last_name].filter(Boolean).join(' ')}</td><td>${i.school_name}</td>
      <td><span class="pill ${INCOMING_STATUS_PILL[normStatus(i.status)]||'warn'}">${t('za_incoming_status_'+normStatus(i.status))}</span></td>
      <td>${fmtDate(i.created_at)}</td>
    </tr>`).join('') : `<tr><td colspan="4" class="hint">${t('za_recruitment_empty')}</td></tr>`;

  const formPanel = direct ? `
  <div class="panel">
    <h3><i data-lucide="user-plus"></i> ${t('za_recruitment_title')}</h3>
    <p class="hint" style="margin-bottom:14px;">${t('za_recruitment_hint_direct')}</p>
    <div class="form-grid">
      <div class="form-field">
        <label>${t('za_f_first_name')}</label>
        <input type="text" id="f_cand_first" placeholder="e.g. Abebe">
      </div>
      <div class="form-field">
        <label>${t('za_f_middle_name')}</label>
        <input type="text" id="f_cand_middle" placeholder="${t('za_optional')}">
      </div>
      <div class="form-field">
        <label>${t('za_f_last_name')}</label>
        <input type="text" id="f_cand_last" placeholder="e.g. Kebede">
      </div>
      <div class="form-field">
        <label>${t('za_f_candidate_phone')}</label>
        <input type="text" id="f_cand_phone" placeholder="e.g. 09xxxxxxxx">
      </div>
      <div class="form-field">
        <label>${t('za_f_candidate_email')}</label>
        <input type="email" id="f_cand_email" placeholder="${t('za_optional')}">
      </div>
      <div class="form-field">
        <label>${t('za_f_recruitment_code')}</label>
        <input type="text" id="f_cand_code" placeholder="${t('za_optional')}">
      </div>
      <div class="form-field">
        <label>${t('za_f_target_school')}</label>
        <select id="f_cand_school"><option value="">${t('za_pick_school')}</option>${schoolOpts}</select>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnPushCandidate">${t('za_recruitment_push')}</button>
    </div>
    <p class="hint" id="recruitmentMsg"></p>
  </div>` : `
  <div class="panel">
    <h3><i data-lucide="user-plus"></i> ${t('za_recruitment_title')}</h3>
    <p class="hint" style="margin-bottom:14px;">${t('za_recruitment_hint_track')}</p>
    <div class="form-actions">
      <button class="btn primary" id="btnGoToProposals">${t('za_recruitment_go_to_proposals')}</button>
    </div>
  </div>`;

  document.getElementById('content').innerHTML = `
  ${formPanel}
  <div class="panel">
    <h3><i data-lucide="clipboard-list"></i> ${t('za_recruitment_pushed_title')}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t('za_th_name')}</th><th>${t('za_th_school')}</th><th>${t('za_th_status')}</th><th>${t('za_th_pushed')}</th></tr>
      ${rows}
    </table></div>
  </div>`;
  if (window.lucide) lucide.createIcons();

  if(!direct){
    document.getElementById('btnGoToProposals').addEventListener('click', ()=>{
      activePage = 'za_nav_proposals';
      render();
    });
    return;
  }

  document.getElementById('btnPushCandidate').addEventListener('click', async ()=>{
    const msg = document.getElementById('recruitmentMsg');
    const first_name = document.getElementById('f_cand_first').value.trim();
    const middle_name = document.getElementById('f_cand_middle').value.trim() || null;
    const last_name = document.getElementById('f_cand_last').value.trim();
    const contact_number = document.getElementById('f_cand_phone').value.trim() || null;
    const email = document.getElementById('f_cand_email').value.trim() || null;
    const zonal_recruitment_code = document.getElementById('f_cand_code').value.trim() || null;
    const school_id = document.getElementById('f_cand_school').value;
    if(!first_name || !last_name || !school_id){
      msg.textContent = '⚠️ ' + t('za_recruitment_required');
      return;
    }
    try {
      const result = await apiPost('/api/zonal/teachers', { school_id, first_name, middle_name, last_name, contact_number, email, zonal_recruitment_code });
      const successText = '✅ ' + result.message;
      // Reload FIRST (rebuilds #recruitmentMsg), then set the confirmation
      // text on the new element — setting it before the reload gets wiped
      // out instantly when the panel re-renders.
      await loadAndRenderRecruitment();
      const newMsg = document.getElementById('recruitmentMsg');
      if(newMsg) newMsg.textContent = successText;
    } catch (err) {
      msg.textContent = '⚠️ ' + err.message;
    }
  });
}

/* ==================================================================
   My Proposals (Teacher Development Coordinator) — live from:
     GET  /api/zonal/proposals   (server scopes this to the caller's
          own submissions since their title isn't Head of Education)
     POST /api/zonal/proposals   body:{proposal_type:'hire_teacher'|
          'appoint_school_admin', school_id, payload}
   ================================================================== */
function myProposalsSkeletonHTML(){
  return `<div class="panel"><h3><i data-lucide="file-pen-line"></i> ${t('za_my_proposals_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderMyProposals(){
  const content = document.getElementById('content');
  try {
    const [schools, proposals, admins] = await Promise.all([
      apiGet('/api/zonal/schools'),
      apiGet('/api/zonal/proposals'),
      apiGet('/api/zonal/admin-users')
    ]);
    renderMyProposalsPanel(schools, proposals, admins);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

const PROPOSAL_STATUS_PILL = { pending:'warn', approved:'ok', rejected:'bad' };
const SCHOOL_ADMIN_TITLES = ['Principal','Academic VP','Admin VP'];

function myProposalTypeFieldsHTML(){
  return `
    <div id="fields_hire_teacher">
      <div class="form-grid">
        <div class="form-field"><label>${t('za_f_first_name')}</label><input type="text" id="mp_first"></div>
        <div class="form-field"><label>${t('za_f_middle_name')}</label><input type="text" id="mp_middle" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label>${t('za_f_last_name')}</label><input type="text" id="mp_last"></div>
        <div class="form-field"><label>${t('za_f_candidate_phone')}</label><input type="text" id="mp_phone" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label>${t('za_f_candidate_email')}</label><input type="email" id="mp_email" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label>${t('za_f_recruitment_code')}</label><input type="text" id="mp_code" placeholder="${t('za_optional')}"></div>
      </div>
    </div>
    <div id="fields_appoint_school_admin" style="display:none;">
      <div class="form-grid">
        <div class="form-field"><label>${t('za_f_first_name')}</label><input type="text" id="mp_a_first"></div>
        <div class="form-field"><label>${t('za_f_middle_name')}</label><input type="text" id="mp_a_middle" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label>${t('za_f_last_name')}</label><input type="text" id="mp_a_last"></div>
        <div class="form-field"><label>${t('za_f_admin_title')}</label>
          <select id="mp_a_title">${SCHOOL_ADMIN_TITLES.map(x=>`<option value="${x}">${teacherTitleLabel(x)}</option>`).join('')}</select>
        </div>
        <div class="form-field"><label>${t('za_f_candidate_phone')}</label><input type="text" id="mp_a_phone" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label>${t('za_f_candidate_email')}</label><input type="email" id="mp_a_email" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label>${t('za_f_password')}</label><input type="password" id="mp_a_password"></div>
      </div>
      <div id="replaceAdminBox" style="display:none;margin-top:10px;padding:10px;border:1px solid var(--border,#333);border-radius:8px;">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" id="mp_a_replace_check">
          <span id="replaceAdminLabel"></span>
        </label>
      </div>
    </div>`;
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
    label.textContent = t('za_replace_admin_question').replace('{name}', existing.first_name + ' ' + existing.last_name).replace('{title}', teacherTitleLabel(title));
    box.dataset.replaceId = existing.admin_id;
  } else {
    box.style.display = 'none';
    check.checked = false;
    box.dataset.replaceId = '';
  }
}

function renderMyProposalsPanel(schools, proposals, admins){
  const schoolName = id => (schools.find(s=>String(s.id)===String(id)) || {}).school_name || '—';
  const schoolOpts = schools.map(s=>`<option value="${s.id}">${s.school_name}</option>`).join('');

  const rows = proposals.length ? proposals.slice().sort((a,b)=> new Date(b.created_at)-new Date(a.created_at)).map(p=>`
    <tr>
      <td>${proposalTypeLabel(p)}</td><td>${proposalSubjectLine(p)}</td><td>${schoolName(p.school_id)}</td>
      <td><span class="pill ${PROPOSAL_STATUS_PILL[normStatus(p.status)]||'warn'}">${t('za_act_status_'+normStatus(p.status))}</span></td>
      <td>${fmtDate(p.created_at)}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="hint">${t('za_my_proposals_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="file-pen-line"></i> ${t('za_my_proposals_new')}</h3>
    <p class="hint" style="margin-bottom:14px;">${t('za_my_proposals_hint')}</p>
    <div class="tabs">
      <button class="tab-btn active" data-type="hire_teacher">${t('za_act_proposal_hire')}</button>
      <button class="tab-btn" data-type="appoint_school_admin">${t('za_act_proposal_admin')}</button>
    </div>
    <div class="form-field" style="max-width:320px;margin-bottom:14px;">
      <label>${t('za_f_target_school')}</label>
      <select id="mp_school"><option value="">${t('za_pick_school')}</option>${schoolOpts}</select>
    </div>
    ${myProposalTypeFieldsHTML()}
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
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      activeType = btn.dataset.type;
      document.getElementById('fields_hire_teacher').style.display = activeType==='hire_teacher' ? '' : 'none';
      document.getElementById('fields_appoint_school_admin').style.display = activeType==='appoint_school_admin' ? '' : 'none';
      if(activeType==='appoint_school_admin') updateReplaceAdminBox(admins);
    });
  });

  // Whenever the target school or the admin title changes, re-check
  // whether that seat is already filled at that school.
  document.getElementById('mp_school').addEventListener('change', ()=>{
    if(activeType==='appoint_school_admin') updateReplaceAdminBox(admins);
  });
  document.getElementById('mp_a_title').addEventListener('change', ()=> updateReplaceAdminBox(admins));

  document.getElementById('btnSubmitProposal').addEventListener('click', async ()=>{
    const msg = document.getElementById('proposalFormMsg');
    const school_id = document.getElementById('mp_school').value;
    if(!school_id){ msg.textContent = '⚠️ ' + t('za_pick_school'); return; }

    let payload;
    if(activeType==='hire_teacher'){
      const first_name = document.getElementById('mp_first').value.trim();
      const last_name = document.getElementById('mp_last').value.trim();
      if(!first_name || !last_name){ msg.textContent = '⚠️ ' + t('za_recruitment_required'); return; }
      payload = {
        first_name, last_name,
        middle_name: document.getElementById('mp_middle').value.trim() || null,
        contact_number: document.getElementById('mp_phone').value.trim() || null,
        email: document.getElementById('mp_email').value.trim() || null,
        zonal_recruitment_code: document.getElementById('mp_code').value.trim() || null
      };
    } else {
      const first_name = document.getElementById('mp_a_first').value.trim();
      const last_name = document.getElementById('mp_a_last').value.trim();
      const password = document.getElementById('mp_a_password').value;
      if(!first_name || !last_name || !password){ msg.textContent = '⚠️ ' + t('za_my_proposals_admin_required'); return; }
      const replaceBox = document.getElementById('replaceAdminBox');
      const wantsReplace = document.getElementById('mp_a_replace_check').checked;
      payload = {
        first_name, last_name, password,
        middle_name: document.getElementById('mp_a_middle').value.trim() || null,
        title: document.getElementById('mp_a_title').value,
        contact_number: document.getElementById('mp_a_phone').value.trim() || null,
        email: document.getElementById('mp_a_email').value.trim() || null,
        replace_admin_id: (wantsReplace && replaceBox.dataset.replaceId) ? replaceBox.dataset.replaceId : null
      };
    }

    try {
      const result = await apiPost('/api/zonal/proposals', { proposal_type: activeType, school_id, payload });
      // Reload FIRST (rebuilds #proposalFormMsg), then set the confirmation
      // text on the new element — otherwise the reload wipes the message
      // before the user ever sees it.
      await loadAndRenderMyProposals();
      const newMsg = document.getElementById('proposalFormMsg');
      if(newMsg) newMsg.textContent = '✅ ' + result.message;
    } catch (err) {
      msg.textContent = '⚠️ ' + err.message;
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
  const photoBlock = data.id_photo_url
    ? `<img class="identity-photo-img" src="${data.id_photo_url}" alt="${name}">`
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
        <label style="display:block;font-size:12px;font-weight:700;color:var(--text-dim);margin-bottom:8px;">${t('za_signature_label')}</label>
        <div class="upload-box">
          ${data.signature_url ? `<img src="${data.signature_url}" alt="signature">` : `<span class="hint">${t('za_no_signature')}</span>`}
          <input type="file" accept="image/*" id="f_sig_file" style="display:none;">
          <button class="btn ghost sm" id="btnUploadSig">${t('za_upload')}</button>
        </div>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:700;color:var(--text-dim);margin-bottom:8px;">${t('za_seal_label')}</label>
        <div class="upload-box">
          ${data.stamp_url ? `<img src="${data.stamp_url}" alt="stamp">` : `<span class="hint">${t('za_no_seal')}</span>`}
          <input type="file" accept="image/*" id="f_seal_file" style="display:none;">
          <button class="btn ghost sm" id="btnUploadSeal">${t('za_upload')}</button>
        </div>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:700;color:var(--text-dim);margin-bottom:8px;">${t('za_id_photo_label')}</label>
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
        <label>${t('za_first_name')}</label>
        <input type="text" id="f_acct_first" value="${(CURRENT_USER.admin_full_name||'').split(' ')[0]||''}">
      </div>
      <div class="form-field">
        <label>${t('za_last_name')}</label>
        <input type="text" id="f_acct_last" value="${(CURRENT_USER.admin_full_name||'').split(' ').slice(1).join(' ')||''}">
      </div>
    </div>
    <div class="form-actions" style="margin-bottom:22px;">
      <button class="btn primary" id="btnSaveName">${t('za_save')}</button>
    </div>
    <div class="form-grid">
      <div class="form-field">
        <label>${t('za_current_password')}</label>
        <input type="password" id="f_acct_curpw">
      </div>
      <div class="form-field">
        <label>${t('za_new_password')}</label>
        <input type="password" id="f_acct_newpw">
      </div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnSavePassword">${t('za_update_password')}</button>
    </div>
    <p class="hint" id="acctMsg"></p>
  </div>`;

  wireSignatureUpload('f_identity_photo_file', 'btnUploadIdentityPhoto', '/api/zonal/upload-id-photo', 'id_photo', 'identityMsg');
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
      await loadAndRenderProfile();
      const newMsg = document.getElementById(msgId || 'signatureMsg');
      if(newMsg) newMsg.textContent = t('za_saved');
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

/* ==================================================================
   My ID — placeholder for the digital ID card (front/back). No
   backend data yet; this just reserves the page and layout so the
   real card design can be dropped in later.
   ================================================================== */
function myIdPanelHTML(){
  return `
  <div class="panel">
    <h3><i data-lucide="credit-card"></i> ${t('za_myid_title')}</h3>
    <p class="hint" style="margin-bottom:18px;">${t('za_myid_hint')}</p>
    <div class="id-card-row">
      <div class="id-card-slot">
        <div class="id-card-slot-label">${t('za_myid_front')}</div>
        <div class="id-card-slot-body">
          <i data-lucide="image"></i>
          <p>${t('za_myid_coming_soon')}</p>
        </div>
      </div>
      <div class="id-card-slot">
        <div class="id-card-slot-label">${t('za_myid_back')}</div>
        <div class="id-card-slot-body">
          <i data-lucide="image"></i>
          <p>${t('za_myid_coming_soon')}</p>
        </div>
      </div>
    </div>
  </div>`;
}

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
function renderTeachersPanel(schools, teachers){
  const schoolOpts = `<option value="">${t('za_teachers_all_schools')}</option>` +
    schools.map(s=>`<option value="${s.id}" ${String(s.id)===String(teachersSchoolFilter)?'selected':''}>${s.school_name}</option>`).join('');

  const sorted = teachers.slice().sort((a,b)=>
    a.school_name.localeCompare(b.school_name) ||
    (teacherTitleRank(a.title) - teacherTitleRank(b.title)) ||
    a.full_name.localeCompare(b.full_name));

  const avatarCell = tch => tch.avatar_url
    ? `<img class="avatar-thumb" src="${tch.avatar_url}" alt="">`
    : `<div class="avatar-thumb avatar-placeholder"><i data-lucide="user"></i></div>`;

  const matchesSearch = (tch, term) => !term || [
    tch.teacher_id, tch.full_name, tch.school_name, tch.title,
    tch.contact_number, tch.email
  ].some(v => v && String(v).toLowerCase().includes(term));

  function renderRows(){
    const term = teachersSearchTerm.trim().toLowerCase();
    const filtered = sorted.filter(tch => matchesSearch(tch, term));
    const rows = filtered.length ? filtered.map(tch=>`
      <tr>
        <td>${avatarCell(tch)}</td>
        <td>${tch.teacher_id}</td>
        <td>${tch.full_name}</td>
        <td>${tch.school_name}</td>
        <td>${teacherTitleLabel(tch.title)}</td>
        <td>${tch.contact_number || '—'}</td>
        <td>${tch.email || '—'}</td>
      </tr>`).join('') : `<tr><td colspan="7" class="hint">${term ? t('za_teachers_search_empty') : t('za_schools_empty')}</td></tr>`;
    const tbody = document.getElementById('teachersTbody');
    if (tbody) tbody.innerHTML = rows;
    if (window.lucide) lucide.createIcons();
  }

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="graduation-cap"></i> ${t('za_teachers_title')}</h3>
    <div class="filters">
      <div class="search-box"><i data-lucide="search"></i><input type="text" id="teacherSearchBox" placeholder="${t('za_teachers_search_placeholder')}" value="${teachersSearchTerm}"></div>
      <select id="teacherSchoolFilter">${schoolOpts}</select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>${t('za_th_photo')}</th>
        <th>${t('za_th_teacher_id')}</th>
        <th>${t('za_th_teacher')}</th>
        <th>${t('za_th_school')}</th>
        <th>${t('za_th_title')}</th>
        <th>${t('za_th_contact')}</th>
        <th>${t('za_th_email')}</th>
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
      <div class="ml-from">${msgBox==='sent' ? m.school_name : (m.sender_name || m.school_name)}</div>
      <div class="ml-subject">${m.subject || t('za_messages_no_subject')}</div>
      <div class="ml-date">${fmtDate(m.sent_at)}</div>
    </div>`).join('') : `<p class="hint">${t('za_messages_empty')}</p>`;

  const recipientOpts = recipients.map(r=>`<option value="${r.school_id}|${r.id}">${r.full_name} — ${r.title?teacherTitleLabel(r.title):''}</option>`).join('');

  const detailHTML = msgComposeTarget !== null ? `
    <div class="msg-detail">
      <h4>${t('za_messages_compose')}</h4>
      <div class="form-field" style="margin:12px 0;">
        <label>${t('za_messages_to')}</label>
        <select id="composeRecipient">${recipientOpts}</select>
      </div>
      <div class="form-field" style="margin-bottom:12px;">
        <label>${t('za_messages_subject')}</label>
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
          ${msgBox==='sent' ? t('za_messages_to')+': '+active.school_name : t('za_messages_from')+': '+(active.sender_name||active.school_name)}
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

let calViewYear = null, calViewMonth = null;

function renderEthiopianCalendarWidget(){
  const today = new Date();
  const todayEc = toEthiopianDate(today);
  if(calViewYear==null){ calViewYear = todayEc.year; calViewMonth = todayEc.month; }

  const daysInMonth = calViewMonth === 13 ? (isLeapEc(calViewYear) ? 6 : 5) : 30;
  // First day-of-week (0=Sun) for the 1st of this Ethiopian month.
  const firstGc = ethiopianToGregorian(calViewYear, calViewMonth, 1);
  const firstDow = firstGc.getDay();

  const dowLabels = [0,1,2,3,4,5,6].map(i=> t('za_cal_dow_'+i));
  let cells = '';
  for(let i=0;i<firstDow;i++) cells += `<div class="cal-day empty"></div>`;
  for(let day=1; day<=daysInMonth; day++){
    const gc = ethiopianToGregorian(calViewYear, calViewMonth, day);
    const isToday = calViewYear===todayEc.year && calViewMonth===todayEc.month && day===todayEc.day;
    const holidayKey = getEthiopianHoliday(gc);
    cells += `<div class="cal-day ${isToday?'today':''} ${holidayKey?'holiday':''}" title="${holidayKey ? t('holiday_'+holidayKey) : ''}">${day}</div>`;
  }

  // Upcoming holidays: scan forward up to 120 days from today.
  const upcoming = [];
  for(let i=0;i<120 && upcoming.length<5;i++){
    const d = new Date(today.getTime() + i*86400000);
    const key = getEthiopianHoliday(d);
    if(key){
      const ec = toEthiopianDate(d);
      upcoming.push({ key, ec, gc: d });
    }
  }
  const holidayRows = upcoming.length ? upcoming.map(h=>`
    <div class="cal-holiday-item">
      <span>${t('holiday_'+h.key)}</span>
      <span class="ch-date">${h.ec.day} ${t('eth_month_'+h.ec.monthKey)} ${h.ec.year} E.C. (${h.gc.toLocaleDateString('en-GB',{day:'numeric',month:'short'})} GC)</span>
    </div>`).join('') : `<p class="hint">${t('za_cal_no_upcoming')}</p>`;

  return `
  <div class="panel">
    <h3><i data-lucide="calendar-days"></i> ${t('za_cal_title')}</h3>
    <div class="cal-widget">
      <div class="cal-widget-cal">
        <div class="cal-head">
          <button class="cal-nav-btn" id="calPrevBtn"><i data-lucide="chevron-left"></i></button>
          <div>
            <div class="cal-title">${t('eth_month_'+ETH_MONTH_KEYS[calViewMonth-1])} ${calViewYear} E.C.</div>
            <div class="cal-sub">${firstGc.toLocaleDateString('en-GB',{month:'long',year:'numeric'})} GC</div>
          </div>
          <button class="cal-nav-btn" id="calNextBtn"><i data-lucide="chevron-right"></i></button>
        </div>
        <div class="cal-grid">
          ${dowLabels.map(l=>`<div class="cal-dow">${l}</div>`).join('')}
          ${cells}
        </div>
      </div>
      <div class="cal-holiday-list">
        <div class="cal-title" style="margin-bottom:10px;">${t('za_cal_upcoming')}</div>
        ${holidayRows}
      </div>
    </div>
  </div>`;
}
function isLeapEc(ecYear){
  return ((ecYear + 1) % 4) === 0;
}
function wireEthiopianCalendarWidget(){
  const prev = document.getElementById('calPrevBtn');
  const next = document.getElementById('calNextBtn');
  if(!prev || !next) return;
  prev.addEventListener('click', ()=>{
    calViewMonth--; if(calViewMonth<1){ calViewMonth=13; calViewYear--; }
    reinjectCalendarWidget();
  });
  next.addEventListener('click', ()=>{
    calViewMonth++; if(calViewMonth>13){ calViewMonth=1; calViewYear++; }
    reinjectCalendarWidget();
  });
}
function reinjectCalendarWidget(){
  const holder = document.getElementById('calWidgetHolder');
  if(!holder) return;
  holder.outerHTML = `<div id="calWidgetHolder">${renderEthiopianCalendarWidget()}</div>`;
  wireEthiopianCalendarWidget();
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
  else if(activePage==='za_nav_subjects') { c.innerHTML = subjectsSkeletonHTML(); loadAndRenderSubjects(); }
  else if(activePage==='za_nav_recruitment') { c.innerHTML = recruitmentSkeletonHTML(); loadAndRenderRecruitment(); }
  else if(activePage==='za_nav_proposals') { c.innerHTML = myProposalsSkeletonHTML(); loadAndRenderMyProposals(); }
  else if(activePage==='za_nav_profile') { c.innerHTML = profileSkeletonHTML(); loadAndRenderProfile(); }
  else if(activePage==='za_nav_myid') { c.innerHTML = myIdPanelHTML(); }
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