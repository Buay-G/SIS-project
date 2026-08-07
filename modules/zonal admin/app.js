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
  hoe:        { titleKey: 'za_role_hoe', icon: '🎓', welcomeKey: 'za_welcome_hoe' },
  tdc:        { titleKey: 'za_role_tdc', icon: '🧭', welcomeKey: 'za_welcome_tdc' },
  supervisor: { titleKey: 'za_role_supervisor', icon: '🔎', welcomeKey: 'za_welcome_sup' }
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
      ["za_nav_dashboard","🏠"],["za_nav_schools","🏫"],
      ["za_nav_approvals","✅"],["za_nav_delegation","🪪"]
    ]},
    {sec:"za_sec_academic", items:[["za_nav_subjects","📘"],["za_nav_students","👥"]]},
    {sec:"za_sec_oversight", items:[["za_nav_performance","📈"],["za_nav_signatures","✍️"],["za_nav_analysis","📊"]]}
  ],
  tdc:[
    {sec:"za_sec_admin", items:[
      ["za_nav_dashboard","🏠"],["za_nav_schools","🏫"],["za_nav_setup_school","➕"],
      ["za_nav_recruitment","🧑‍🏫"],["za_nav_proposals","📝"]
    ]},
    {sec:"za_sec_academic", items:[["za_nav_subjects","📘"],["za_nav_students","👥"]]},
    {sec:"za_sec_oversight", items:[["za_nav_performance","📈"],["za_nav_analysis","📊"]]}
  ],
  supervisor:[
    {sec:"za_sec_admin", items:[["za_nav_dashboard","🏠"],["za_nav_schools","🏫"]]},
    {sec:"za_sec_oversight", items:[["za_nav_performance","📈"]]}
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
      el.innerHTML = `<span class="ic">${icon}</span><span>${t(key)}</span>`;
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
  document.getElementById('roleIcon').textContent = meta.icon;
  document.getElementById('roleTitleTxt').textContent = t(meta.titleKey);
  document.getElementById('roleIdTxt').textContent = CURRENT_USER.user_id;
  document.getElementById('whoName').textContent = name;
  document.getElementById('whoRole').textContent = t(meta.titleKey);
  document.getElementById('avatarInit').textContent = initialsOf(name);
  document.getElementById('pageTitle').textContent = t(activePage);
  const ay = CURRENT_USER.academic_year;
  document.getElementById('academicYearBadge').textContent = ay
    ? '📅 ' + t('sa_topbar_academic_year', { year: ay.ec_year, gcRange: ay.gc_range })
    : '📅';
}

function errorPanel(err){
  const msg = (err && err.message) || String(err);
  return `<div class="panel"><p class="hint">⚠️ ${msg}${msg.includes('logged in') ? '' : ''}</p></div>`;
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
  const statusKey = p.status==='pending' ? 'za_act_status_pending' : p.status==='approved' ? 'za_act_status_approved' : 'za_act_status_rejected';
  return { school: schoolName || '—', event: `${label} — ${t(statusKey)}`, date: p.reviewed_at || p.created_at };
}

function incomingActivityLine(i){
  const key = i.status==='pending' ? 'za_act_teacher_pushed' : i.status==='accepted' ? 'za_act_teacher_accepted' : 'za_act_teacher_declined';
  return { school: i.school_name, event: t(key), date: i.decided_at || i.created_at };
}

function renderDashboard({ schools, students, proposals, incoming, performance }){
  const meta = ROLE_META[role];
  let cards = `
    <div class="card">
      <div class="icon">🏫</div>
      <div><div class="label">${t(role==='supervisor' ? 'za_assigned_schools' : 'za_total_schools')}</div>
      <div class="value">${schools.length}</div></div>
    </div>`;

  let activity = [];

  if(role!=='supervisor'){
    const totals = students.totals || { male: 0, female: 0, total: 0 };
    const pendingProposals = proposals.filter(p=>p.status==='pending').length;
    const pendingIncoming = incoming.filter(i=>i.status==='pending').length;
    cards += `
    <div class="card">
      <div class="icon">👥</div>
      <div><div class="label">${t('za_total_students')}</div>
      <div class="value">${totals.total.toLocaleString()}</div>
      <div class="subrow">♂ ${totals.male.toLocaleString()} &nbsp;&nbsp; ♀ ${totals.female.toLocaleString()}</div></div>
    </div>
    <div class="card alert">
      <div class="icon">📝</div>
      <div><div class="label">${t('za_pending_proposals')}</div>
      <div class="value">${pendingProposals}</div></div>
    </div>
    <div class="card">
      <div class="icon">🧑‍🏫</div>
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
      <div class="icon">⚠️</div>
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
    <h3>📋 ${t('za_recent_activity')}</h3>
    <table>
      <tr><th>${t('za_th_school')}</th><th>Event</th><th>Date</th></tr>
      ${activityRows}
    </table>
    ${role==='supervisor' ? `<div class="hint">${t('za_locked_note')}</div>` : ''}
  </div>`;
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
  return `<div class="panel"><h3>👥 ${t('za_students_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderStudents(filters){
  const content = document.getElementById('content');
  if(role==='supervisor'){
    content.innerHTML = `<div class="panel"><h3>👥 ${t('za_students_title')}</h3>
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
  'Active':      'ok',
  'Graduated':   'grad',
  'Dropped':     'bad'
  // anything else (e.g. 'Transferred Out') falls through to 'warn' below
};

function studentStatusPill(status){
  const cls = STUDENT_STATUS_PILL[status] || (String(status||'').startsWith('Transferred') ? 'warn' : 'warn');
  return `<span class="pill ${cls}">${status || '—'}</span>`;
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
  const classOpts = ['9','10','11','12'].map(c=>`<option value="${c}" ${filters.class_level===c?'selected':''}>Grade ${c}</option>`).join('');
  const streamOpts = ['General','Natural','Social'].map(s=>`<option value="${s}" ${filters.stream===s?'selected':''}>${s}</option>`).join('');
  const sectionOpts = ['A','B','C','D'].map(s=>`<option value="${s}" ${filters.section===s?'selected':''}>${s}</option>`).join('');
  const statusOpts = ['Active','Graduated','Dropped','Transferred Out'].map(s=>`<option value="${s}" ${filters.status===s?'selected':''}>${s}</option>`).join('');
  const yearOpts = years.map(y=>`<option value="${y}" ${String(filters.enrollment_year)===String(y)?'selected':''}>${y}</option>`).join('');

  const tableRows = rows.length ? rows.map(r=>`
    <tr>
      <td>${r.student_id}</td><td>${r.full_name}</td><td>Grade ${r.class_level}</td>
      <td>${r.stream || '—'}</td><td>${r.section || '—'}</td><td>${r.enrollment_year || '—'}</td>
      <td>${studentStatusPill(r.status)}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="hint">${t('za_students_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3>👥 ${t('za_students_title')}</h3>
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
    <table>
      <tr>
        <th>${t('za_th_id')}</th><th>${t('za_th_name')}</th><th>${t('za_th_class')}</th><th>${t('za_th_stream')}</th>
        <th>${t('za_th_section')}</th><th>${t('za_th_enroll_year')}</th><th>${t('za_th_status')}</th>
      </tr>
      ${tableRows}
    </table>
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
      schoolName(r.school_id), r.student_id, r.full_name, `Grade ${r.class_level}`,
      r.stream || '', r.section || '', r.enrollment_year || '', r.status || ''
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

/* ---------------- Performance — live from /api/zonal/performance ---- */
function performanceSkeletonHTML(){
  return `<div class="panel"><h3>📈 ${t('za_performance_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderPerformance(){
  const content = document.getElementById('content');
  try {
    const [schools, rows] = await Promise.all([
      apiGet('/api/zonal/schools'),
      apiGet('/api/zonal/performance')
    ]);
    renderPerformancePanel(schools, rows);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function renderPerformancePanel(schools, rows){
  const schoolName = id => (schools.find(s=>String(s.id)===String(id)) || {}).school_name || '—';

  const tableRows = rows.length ? rows.map(r=>{
    const attendance = r.periods_logged_last_14_days > 0
      ? Math.round((r.periods_present_last_14_days / r.periods_logged_last_14_days) * 100) + '%'
      : '—';
    const lastMarksLabel = r.days_since_marks_upload != null ? `${r.days_since_marks_upload}d` : t('za_no_uploads_yet');
    const pill = r.needs_followup
      ? `<span class="pill bad">${t('za_status_followup')}</span>`
      : (r.days_since_marks_upload != null && r.days_since_marks_upload > 7)
        ? `<span class="pill warn">${t('za_status_watch')}</span>`
        : `<span class="pill ok">${t('za_status_ontrack')}</span>`;
    return `<tr>
      <td>${r.full_name}</td><td>${schoolName(r.school_id)}</td><td>${attendance}</td>
      <td>${lastMarksLabel}</td><td>${pill}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="hint">${t('za_schools_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3>📈 ${t('za_performance_title')}</h3>
    <table>
      <tr><th>${t('za_th_teacher')}</th><th>${t('za_th_school')}</th><th>${t('za_th_attendance')}</th><th>${t('za_th_last_marks')}</th><th>${t('za_th_status')}</th></tr>
      ${tableRows}
    </table>
  </div>`;
}

/* ---- Setup New School: real cascading region -> zone -> woreda -> kebele,
   backed by /api/zonal/lookup/* ---- */
function setupSchoolSkeletonHTML(){
  return `<div class="panel"><h3>➕ ${t('za_setup_title')}</h3><p class="hint">Loading…</p></div>`;
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
    <h3>➕ ${t('za_setup_title')}</h3>
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
    msg.textContent = '⚠️ School name and prefix are required.';
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
  return `<div class="panel"><h3>${icon} ${t(titleKey)}</h3>
    <p class="hint">${t('za_generic_hint')}</p></div>`;
}

/* ---------------- Schools — live from /api/zonal/schools ------------ */
function schoolsSkeletonHTML(){
  return `<div class="panel"><h3>🏫 ${t('za_schools_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
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
    <h3>🏫 ${t('za_schools_title')}</h3>
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
  return `<div class="panel"><h3>✅ ${t('za_approvals_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
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
  const pending = proposals.filter(p=>p.status==='pending');
  const decided = proposals.filter(p=>p.status!=='pending')
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
      <td>${p.status==='approved' ? `<span class="pill ok">${t('za_act_status_approved')}</span>` : `<span class="pill bad">${t('za_act_status_rejected')}</span>`}</td>
      <td>${fmtDate(p.reviewed_at)}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="hint">${t('za_activity_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3>✅ ${t('za_approvals_title')}</h3>
    <p class="hint" style="margin-bottom:14px;">${t('za_approvals_hint')}</p>
    <div id="approvalsQueue">${pendingHTML}</div>
    <p class="hint" id="approvalsMsg"></p>
  </div>
  <div class="panel">
    <h3>📋 ${t('za_approvals_history')}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t('za_th_type')}</th><th>${t('za_th_name')}</th><th>${t('za_th_school')}</th><th>${t('za_th_status')}</th><th>${t('za_th_decided')}</th></tr>
      ${decidedRows}
    </table></div>
  </div>`;

  document.getElementById('approvalsQueue').addEventListener('click', async (e)=>{
    const btn = e.target.closest('button[data-act]');
    if(!btn) return;
    const id = btn.dataset.id;
    const msg = document.getElementById('approvalsMsg');
    try {
      if(btn.dataset.act==='approve'){
        const result = await apiPost(`/api/zonal/proposals/${id}/approve`);
        msg.textContent = '✅ ' + result.message;
      } else {
        const reason = prompt(t('sa_prompt_rejection_reason')) || '';
        await apiPost(`/api/zonal/proposals/${id}/reject`, { reason });
      }
      loadAndRenderApprovals();
    } catch (err) {
      msg.textContent = '⚠️ ' + err.message;
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
  return `<div class="panel"><h3>🪪 ${t('za_delegation_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
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
    <h3>🪪 ${t('za_delegation_title')}</h3>
    <p class="hint" style="margin-bottom:8px;">${t('za_delegation_hint')}</p>
    <div id="delegationList">${rows}</div>
    <p class="hint" id="delegationMsg"></p>
  </div>`;

  document.querySelectorAll('.delegateToggle').forEach(toggle=>{
    toggle.addEventListener('change', async ()=>{
      const msg = document.getElementById('delegationMsg');
      try {
        const result = await apiPost(`/api/zonal/teamleader/${toggle.dataset.id}/delegate`, { can_act_independently: toggle.checked });
        msg.textContent = '✅ ' + result.message;
        loadAndRenderDelegation();
      } catch (err) {
        toggle.checked = !toggle.checked;
        msg.textContent = '⚠️ ' + err.message;
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
  return `<div class="panel"><h3>📘 ${t('za_subjects_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
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
    <h3>📘 ${t('za_subjects_title')}</h3>
    <p class="hint" style="margin-bottom:14px;">${t('za_subjects_hint')}</p>
    ${formHTML}
  </div>
  <div class="panel">
    <h3>📚 ${t('za_subjects_list')}</h3>
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
        if(!confirm(t('za_subjects_delete_confirm'))) return;
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
  return `<div class="panel"><h3>🧑‍🏫 ${t('za_recruitment_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
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

function renderRecruitmentPanel(schools, incoming){
  const schoolOpts = schools.map(s=>`<option value="${s.id}">${s.school_name}</option>`).join('');
  const direct = canActInZone();

  const rows = incoming.length ? incoming.slice().sort((a,b)=> new Date(b.created_at)-new Date(a.created_at)).map(i=>`
    <tr>
      <td>${[i.first_name, i.middle_name, i.last_name].filter(Boolean).join(' ')}</td><td>${i.school_name}</td>
      <td><span class="pill ${INCOMING_STATUS_PILL[i.status]||'warn'}">${t('za_incoming_status_'+i.status)}</span></td>
      <td>${fmtDate(i.created_at)}</td>
    </tr>`).join('') : `<tr><td colspan="4" class="hint">${t('za_recruitment_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3>🧑‍🏫 ${t('za_recruitment_title')}</h3>
    <p class="hint" style="margin-bottom:14px;">${direct ? t('za_recruitment_hint_direct') : t('za_recruitment_hint_proposal')}</p>
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
      <button class="btn primary" id="btnPushCandidate">${direct ? t('za_recruitment_push') : t('za_recruitment_submit_proposal')}</button>
    </div>
    <p class="hint" id="recruitmentMsg"></p>
  </div>
  <div class="panel">
    <h3>📋 ${t('za_recruitment_pushed_title')}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t('za_th_name')}</th><th>${t('za_th_school')}</th><th>${t('za_th_status')}</th><th>${t('za_th_pushed')}</th></tr>
      ${rows}
    </table></div>
  </div>`;

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
      if(direct){
        const result = await apiPost('/api/zonal/teachers', { school_id, first_name, middle_name, last_name, contact_number, email, zonal_recruitment_code });
        msg.textContent = '✅ ' + result.message;
      } else {
        const result = await apiPost('/api/zonal/proposals', {
          proposal_type: 'hire_teacher', school_id,
          payload: { first_name, middle_name, last_name, contact_number, email, zonal_recruitment_code }
        });
        msg.textContent = '✅ ' + result.message;
      }
      loadAndRenderRecruitment();
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
  return `<div class="panel"><h3>📝 ${t('za_my_proposals_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderMyProposals(){
  const content = document.getElementById('content');
  try {
    const [schools, proposals] = await Promise.all([
      apiGet('/api/zonal/schools'),
      apiGet('/api/zonal/proposals')
    ]);
    renderMyProposalsPanel(schools, proposals);
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
          <select id="mp_a_title">${SCHOOL_ADMIN_TITLES.map(x=>`<option value="${x}">${x}</option>`).join('')}</select>
        </div>
        <div class="form-field"><label>${t('za_f_candidate_phone')}</label><input type="text" id="mp_a_phone" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label>${t('za_f_candidate_email')}</label><input type="email" id="mp_a_email" placeholder="${t('za_optional')}"></div>
        <div class="form-field"><label>${t('za_f_password')}</label><input type="password" id="mp_a_password"></div>
      </div>
    </div>`;
}

function renderMyProposalsPanel(schools, proposals){
  const schoolName = id => (schools.find(s=>String(s.id)===String(id)) || {}).school_name || '—';
  const schoolOpts = schools.map(s=>`<option value="${s.id}">${s.school_name}</option>`).join('');

  const rows = proposals.length ? proposals.slice().sort((a,b)=> new Date(b.created_at)-new Date(a.created_at)).map(p=>`
    <tr>
      <td>${proposalTypeLabel(p)}</td><td>${proposalSubjectLine(p)}</td><td>${schoolName(p.school_id)}</td>
      <td><span class="pill ${PROPOSAL_STATUS_PILL[p.status]||'warn'}">${t('za_act_status_'+p.status)}</span></td>
      <td>${fmtDate(p.created_at)}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="hint">${t('za_my_proposals_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3>📝 ${t('za_my_proposals_new')}</h3>
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
    <h3>📋 ${t('za_my_proposals_title')}</h3>
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
    });
  });

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
      payload = {
        first_name, last_name, password,
        middle_name: document.getElementById('mp_a_middle').value.trim() || null,
        title: document.getElementById('mp_a_title').value,
        contact_number: document.getElementById('mp_a_phone').value.trim() || null,
        email: document.getElementById('mp_a_email').value.trim() || null
      };
    }

    try {
      const result = await apiPost('/api/zonal/proposals', { proposal_type: activeType, school_id, payload });
      msg.textContent = '✅ ' + result.message;
      loadAndRenderMyProposals();
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
function signaturesSkeletonHTML(){
  return `<div class="panel"><h3>✍️ ${t('za_signatures_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderSignatures(){
  const content = document.getElementById('content');
  try {
    const data = await apiGet('/api/zonal/profile-documents');
    renderSignaturesPanel(data);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function renderSignaturesPanel(data){
  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3>✍️ ${t('za_signatures_title')}</h3>
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
    </div>
    <p class="hint" id="signatureMsg"></p>
  </div>`;

  wireSignatureUpload('f_sig_file', 'btnUploadSig', '/api/zonal/upload-signature', 'signature');
  wireSignatureUpload('f_seal_file', 'btnUploadSeal', '/api/zonal/upload-stamp', 'stamp');
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

function wireSignatureUpload(fileId, btnId, path, fieldName){
  const fileEl = document.getElementById(fileId);
  const btn = document.getElementById(btnId);
  btn.addEventListener('click', ()=> fileEl.click());
  fileEl.addEventListener('change', async ()=>{
    const file = fileEl.files[0];
    const msg = document.getElementById('signatureMsg');
    if(!file) return;
    if(file.size > 2*1024*1024){ msg.textContent = '⚠️ ' + t('za_signature_too_large'); return; }
    try {
      await uploadZonalFile(path, fieldName, file);
      msg.textContent = '✅ ' + t('za_saved');
      loadAndRenderSignatures();
    } catch (err) {
      msg.textContent = '⚠️ ' + err.message;
    }
  });
}

/* ==================================================================
   Analysis Report (HoE + TDC) — live from:
     GET /api/zonal/analysis-reports?term=Semester 1|Semester 2|Year
       -> { term, schools: [{ school_id, school_name, rows: [{
            class_level, total_student:{male,female,total},
            drop_out:{...}, tested:{...}, incomplete:{...},
            band_0_49:{...}, band_50_74:{...}, band_75_100:{...},
            highest_rank_male, highest_rank_female }], totals: {...same shape} }] }
   ================================================================== */
const ANALYSIS_TERMS = ['Semester 1','Semester 2','Year'];
let analysisTerm = 'Year';
let analysisSchoolId = null;

function analysisSkeletonHTML(){
  return `<div class="panel"><h3>📊 ${t('za_analysis_title')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}

async function loadAndRenderAnalysis(){
  const content = document.getElementById('content');
  try {
    const data = await apiGet('/api/zonal/analysis-reports', { term: analysisTerm });
    if(!analysisSchoolId && data.schools.length) analysisSchoolId = data.schools[0].school_id;
    renderAnalysisPanel(data);
  } catch (err) {
    content.innerHTML = errorPanel(err);
  }
}

function analysisRowHTML(r){
  const label = r.class_level==='Total' ? t('za_total') : t('za_grade_short', { level: r.class_level });
  return `<tr>
    <td>${label}</td>
    <td>${r.total_student.total}</td>
    <td>${r.drop_out.total}</td>
    <td>${r.tested.total}</td>
    <td>${r.incomplete.total}</td>
    <td>${r.band_0_49.total}</td>
    <td>${r.band_50_74.total}</td>
    <td>${r.band_75_100.total}</td>
    <td>${r.highest_rank_male}/${r.highest_rank_female}</td>
  </tr>`;
}

function renderAnalysisPanel(data){
  const schools = data.schools || [];
  const schoolOpts = schools.map(s=>`<option value="${s.school_id}" ${String(s.school_id)===String(analysisSchoolId)?'selected':''}>${s.school_name}</option>`).join('');
  const current = schools.find(s=>String(s.school_id)===String(analysisSchoolId)) || schools[0];

  const zoneTotals = schools.reduce((acc, s)=>{
    acc.total += s.totals.total_student.total;
    acc.dropout += s.totals.drop_out.total;
    acc.tested += s.totals.tested.total;
    acc.passing += s.totals.band_50_74.total + s.totals.band_75_100.total;
    return acc;
  }, { total:0, dropout:0, tested:0, passing:0 });
  const dropoutRate = zoneTotals.total ? (zoneTotals.dropout/zoneTotals.total*100) : null;
  const passRate = zoneTotals.tested ? (zoneTotals.passing/zoneTotals.tested*100) : null;

  const termTabs = ANALYSIS_TERMS.map(term=>`<button class="tab-btn ${term===analysisTerm?'active':''}" data-term="${term}">${t('za_term_'+term.replace(/\s+/g,'').toLowerCase())}</button>`).join('');

  const tableHTML = current ? `
    <div class="table-wrap"><table>
      <tr>
        <th>${t('za_analysis_class')}</th><th>${t('za_analysis_total')}</th><th>${t('za_analysis_dropout')}</th>
        <th>${t('za_analysis_tested')}</th><th>${t('za_analysis_incomplete')}</th>
        <th>0–49</th><th>50–74</th><th>75–100</th><th>${t('za_analysis_top_mf')}</th>
      </tr>
      ${current.rows.map(analysisRowHTML).join('')}
      <tr style="font-weight:700;">${analysisRowHTML(current.totals).replace('<tr>','').replace('</tr>','')}</tr>
    </table></div>` : `<p class="hint">${t('za_schools_empty')}</p>`;

  document.getElementById('content').innerHTML = `
  <div class="cards">
    <div class="card">
      <div class="icon">📉</div>
      <div><div class="label">${t('za_analysis_dropout_rate')}</div><div class="value">${dropoutRate!=null ? dropoutRate.toFixed(1)+'%' : '—'}</div></div>
    </div>
    <div class="card">
      <div class="icon">🎯</div>
      <div><div class="label">${t('za_analysis_pass_rate')}</div><div class="value">${passRate!=null ? Math.round(passRate)+'%' : '—'}</div></div>
    </div>
  </div>
  <div class="panel">
    <h3>📊 ${t('za_analysis_title')}</h3>
    <div class="tabs">${termTabs}</div>
    <div class="form-field" style="max-width:320px;margin-bottom:16px;">
      <label>${t('za_analysis_select_school')}</label>
      <select id="analysisSchoolSelect">${schoolOpts}</select>
    </div>
    ${tableHTML}
  </div>`;

  document.querySelectorAll('.tab-btn[data-term]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      analysisTerm = btn.dataset.term;
      document.getElementById('content').innerHTML = analysisSkeletonHTML();
      loadAndRenderAnalysis();
    });
  });
  const schoolSelect = document.getElementById('analysisSchoolSelect');
  if(schoolSelect){
    schoolSelect.addEventListener('change', ()=>{
      analysisSchoolId = schoolSelect.value;
      renderAnalysisPanel(data);
    });
  }
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
  else if(activePage==='za_nav_performance') { c.innerHTML = performanceSkeletonHTML(); loadAndRenderPerformance(); }
  else if(activePage==='za_nav_setup_school') { c.innerHTML = setupSchoolSkeletonHTML(); loadAndRenderSetupSchool(); }
  else if(activePage==='za_nav_approvals') { c.innerHTML = approvalsSkeletonHTML(); loadAndRenderApprovals(); }
  else if(activePage==='za_nav_delegation') { c.innerHTML = delegationSkeletonHTML(); loadAndRenderDelegation(); }
  else if(activePage==='za_nav_subjects') { c.innerHTML = subjectsSkeletonHTML(); loadAndRenderSubjects(); }
  else if(activePage==='za_nav_recruitment') { c.innerHTML = recruitmentSkeletonHTML(); loadAndRenderRecruitment(); }
  else if(activePage==='za_nav_proposals') { c.innerHTML = myProposalsSkeletonHTML(); loadAndRenderMyProposals(); }
  else if(activePage==='za_nav_signatures') { c.innerHTML = signaturesSkeletonHTML(); loadAndRenderSignatures(); }
  else if(activePage==='za_nav_analysis') { c.innerHTML = analysisSkeletonHTML(); loadAndRenderAnalysis(); }
  else c.innerHTML = genericPanel(activePage, '📄');
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
    if(!confirm(t('za_logout_confirm'))) return;
    try { await apiPost('/api/logout'); } catch (err) { /* clearing the cookie server-side is best-effort; redirect regardless */ }
    window.location.href = '/login.html';
  });

  document.getElementById('navOpenBtn').addEventListener('click', openMobileNav);
  document.getElementById('navCloseBtn').addEventListener('click', closeMobileNav);
  document.getElementById('navOverlay').addEventListener('click', closeMobileNav);

  loadNotifications();
  setInterval(loadNotifications, 60000);
}

async function boot(){
  try {
    await loadCurrentUser();
  } catch (err) {
    return; // loadCurrentUser already redirected to /login.html
  }
  wireChrome();
  render();
}

// i18n.js calls applyTranslations() on DOMContentLoaded for static
// [data-i18n] elements, and window.onSisLangChange() (if defined) after
// every setLang() call so dynamically-built content re-renders too.
window.onSisLangChange = ()=>{ if(CURRENT_USER) render(); };
document.addEventListener('DOMContentLoaded', boot);