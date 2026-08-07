/* This file relies on i18n.js being loaded first (t, applyTranslations,
   getCurrentLang, window.setLang) — see index.html script order. All
   copy lives in i18n.js under the za_* keys; nothing is hardcoded here. */

let role = 'hoe';

const ROLE_META = {
  hoe:        { titleKey: 'za_role_hoe', icon: '🎓', idLabel: 'GCEO-HOE-001', welcomeKey: 'za_welcome_hoe', name: 'Abebe Tulu', initials: 'AT' },
  tdc:        { titleKey: 'za_role_tdc', icon: '🧭', idLabel: 'GCEO-TDC-014', welcomeKey: 'za_welcome_tdc', name: 'Nyaruot Gatkuoth', initials: 'NG' },
  supervisor: { titleKey: 'za_role_supervisor', icon: '🔎', idLabel: 'GCEO-SUP-032', welcomeKey: 'za_welcome_sup', name: 'Ochan Owila', initials: 'OO' }
};

const NAV = {
  hoe:[
    {sec:"za_sec_admin", items:[
      ["za_nav_dashboard","🏠"],["za_nav_schools","🏫"],["za_nav_setup_school","➕"],
      ["za_nav_recruitment","🧑‍🏫"],["za_nav_approvals","✅"],["za_nav_delegation","🪪"]
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
      el.onclick = ()=>{ activePage = key; render(); };
      wrap.appendChild(el);
    });
  });
}

function renderTopChrome(){
  const meta = ROLE_META[role];
  document.getElementById('roleIcon').textContent = meta.icon;
  document.getElementById('roleTitleTxt').textContent = t(meta.titleKey);
  document.getElementById('roleIdTxt').textContent = meta.idLabel;
  document.getElementById('whoName').textContent = meta.name;
  document.getElementById('whoRole').textContent = t(meta.titleKey);
  document.getElementById('avatarInit').textContent = meta.initials;
  document.getElementById('pageTitle').textContent = t(activePage);
  document.getElementById('academicYearBadge').textContent =
    '📅 ' + t('sa_topbar_academic_year', { year: '2018', gcRange: '2025/2026' });
}

function dashboardHTML(){
  const meta = ROLE_META[role];
  let cards = `
    <div class="card">
      <div class="icon">🏫</div>
      <div><div class="label">${t('za_total_schools')}</div>
      <div class="value">${role==='supervisor'? '2':'14'}</div></div>
    </div>`;
  if(role!=='supervisor'){
    cards += `
    <div class="card">
      <div class="icon">👥</div>
      <div><div class="label">${t('za_total_students')}</div>
      <div class="value">6,842</div>
      <div class="subrow">♂ 3,510 &nbsp;&nbsp; ♀ 3,332</div></div>
    </div>
    <div class="card alert">
      <div class="icon">📝</div>
      <div><div class="label">${t('za_pending_proposals')}</div>
      <div class="value">${role==='hoe' ? '5':'2'}</div></div>
    </div>
    <div class="card">
      <div class="icon">🧑‍🏫</div>
      <div><div class="label">${t('za_incoming_pushed')}</div>
      <div class="value">3</div></div>
    </div>`;
  } else {
    cards += `
    <div class="card">
      <div class="icon">🏫</div>
      <div><div class="label">${t('za_assigned_schools')}</div>
      <div class="value">2</div></div>
    </div>
    <div class="card alert">
      <div class="icon">⚠️</div>
      <div><div class="label">${t('za_flagged_teachers')}</div>
      <div class="value">4</div></div>
    </div>`;
  }

  return `
  <div class="welcome">
    <h2>${t(meta.welcomeKey)}</h2>
    <p>${t('za_welcome_sub')}</p>
  </div>
  <div class="cards">${cards}</div>
  <div class="panel">
    <h3>📋 ${t('za_recent_activity')}</h3>
    <table>
      <tr><th>${t('za_th_school')}</th><th>Event</th><th>Date</th></tr>
      <tr><td>Newland Secondary School</td><td>Teacher push accepted by Principal</td><td>Aug 6, 2026</td></tr>
      <tr><td>Abobo Preparatory School</td><td>Marks not uploaded in 15 days — flagged</td><td>Aug 5, 2026</td></tr>
      <tr><td>Itang General Secondary School</td><td>Admin appointment proposal submitted</td><td>Aug 4, 2026</td></tr>
    </table>
    ${role==='supervisor' ? `<div class="hint">${t('za_locked_note')}</div>` : ''}
  </div>`;
}

function studentsHTML(){
  if(role==='supervisor'){
    return `<div class="panel"><h3>👥 ${t('za_students_title')}</h3>
      <p class="hint">${t('za_locked_note')}</p></div>`;
  }
  const schoolOpts = SCHOOLS.map(s=>`<option>${s.name}</option>`).join('');
  const totalM = STUDENT_ROWS.reduce((a,r)=>a+r.male,0);
  const totalF = STUDENT_ROWS.reduce((a,r)=>a+r.female,0);
  const rows = STUDENT_ROWS.map(r=>`
    <tr>
      <td>${r.school}</td><td>Grade ${r.class}</td><td>${r.stream}</td><td>${r.section}</td>
      <td>${r.male}</td><td>${r.female}</td><td><b>${r.male+r.female}</b></td>
    </tr>`).join('');

  return `
  <div class="panel">
    <h3>👥 ${t('za_students_title')}</h3>
    <p class="hint" style="margin-bottom:14px;">${t('za_students_hint')}</p>
    <div class="filters">
      <select><option>${t('za_all')} — ${t('za_filters_school')}</option>${schoolOpts}</select>
      <select><option>${t('za_all')} — ${t('za_filters_class')}</option><option>Grade 9</option><option>Grade 10</option><option>Grade 11</option><option>Grade 12</option></select>
      <select><option>${t('za_all')} — ${t('za_filters_stream')}</option><option>General</option><option>Natural</option><option>Social</option></select>
      <select><option>${t('za_all')} — ${t('za_filters_section')}</option><option>A</option><option>B</option><option>C</option></select>
    </div>
    <div class="gender-strip">
      <div class="gender-chip total"><div class="n">${totalM+totalF}</div><div class="l">${t('za_total')}</div></div>
      <div class="gender-chip male"><div class="n">${totalM}</div><div class="l">♂ ${t('za_male')}</div></div>
      <div class="gender-chip female"><div class="n">${totalF}</div><div class="l">♀ ${t('za_female')}</div></div>
    </div>
    <table>
      <tr>
        <th>${t('za_th_school')}</th><th>${t('za_th_class')}</th><th>${t('za_th_stream')}</th><th>${t('za_th_section')}</th>
        <th>${t('za_th_male')}</th><th>${t('za_th_female')}</th><th>${t('za_th_total')}</th>
      </tr>
      ${rows}
    </table>
  </div>`;
}

function performanceHTML(){
  return `
  <div class="panel">
    <h3>📈 ${t('za_performance_title')}</h3>
    <table>
      <tr><th>${t('za_th_teacher')}</th><th>${t('za_th_school')}</th><th>${t('za_th_attendance')}</th><th>${t('za_th_last_marks')}</th><th>${t('za_th_status')}</th></tr>
      <tr><td>Teacher A. Deng</td><td>Newland Secondary School</td><td>65%</td><td>18 days ago</td><td><span class="pill bad">${t('za_status_followup')}</span></td></tr>
      <tr><td>Teacher M. Nyikaw</td><td>Abobo Preparatory School</td><td>92%</td><td>4 days ago</td><td><span class="pill ok">${t('za_status_ontrack')}</span></td></tr>
      <tr><td>Teacher S. Ojulo</td><td>Newland Secondary School</td><td>78%</td><td>10 days ago</td><td><span class="pill warn">${t('za_status_watch')}</span></td></tr>
    </table>
  </div>`;
}

/* ---- Setup New School: cascading region -> zone -> woreda -> kebele ---- */
function setupSchoolHTML(){
  const regionOpts = REGIONS.map(r=>`<option value="${r.region_id}">${r.region_name}</option>`).join('');
  return `
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
      <button class="btn primary">${t('za_save_school')}</button>
      <button class="btn ghost">${t('za_cancel')}</button>
    </div>
  </div>`;
}

function wireCascadingSelects(){
  const regionEl = document.getElementById('f_region');
  const zoneEl = document.getElementById('f_zone');
  const woredaEl = document.getElementById('f_woreda');
  const kebeleEl = document.getElementById('f_kebele');
  if(!regionEl) return;

  function fillSelect(el, rows, idKey, nameKey, placeholder){
    el.innerHTML = `<option value="">${placeholder}</option>` +
      rows.map(r=>`<option value="${r[idKey]}">${r[nameKey]}</option>`).join('');
  }

  regionEl.addEventListener('change', ()=>{
    const zones = ZONES.filter(z=>String(z.region_id)===regionEl.value);
    fillSelect(zoneEl, zones, 'zone_id', 'zone_name', t('za_pick_zone'));
    zoneEl.disabled = zones.length===0;
    fillSelect(woredaEl, [], 'woreda_id', 'woreda_name', t('za_pick_woreda'));
    woredaEl.disabled = true;
    fillSelect(kebeleEl, [], 'kebele_id', 'kebele_name', t('za_pick_kebele'));
    kebeleEl.disabled = true;
  });

  zoneEl.addEventListener('change', ()=>{
    const woredas = WOREDAS.filter(w=>String(w.zone_id)===zoneEl.value);
    fillSelect(woredaEl, woredas, 'woreda_id', 'woreda_name', t('za_pick_woreda'));
    woredaEl.disabled = woredas.length===0;
    fillSelect(kebeleEl, [], 'kebele_id', 'kebele_name', t('za_pick_kebele'));
    kebeleEl.disabled = true;
  });

  woredaEl.addEventListener('change', ()=>{
    const kebeles = KEBELES.filter(k=>String(k.woreda_id)===woredaEl.value);
    fillSelect(kebeleEl, kebeles, 'kebele_id', 'kebele_name', t('za_pick_kebele'));
    kebeleEl.disabled = kebeles.length===0;
  });
}

function genericPanel(titleKey, icon){
  return `<div class="panel"><h3>${icon} ${t(titleKey)}</h3>
    <p class="hint">${t('za_generic_hint')}</p></div>`;
}

function render(){
  renderNav();
  renderTopChrome();
  const c = document.getElementById('content');
  if(activePage==='za_nav_dashboard') c.innerHTML = dashboardHTML();
  else if(activePage==='za_nav_students') c.innerHTML = studentsHTML();
  else if(activePage==='za_nav_performance') c.innerHTML = performanceHTML();
  else if(activePage==='za_nav_setup_school') { c.innerHTML = setupSchoolHTML(); wireCascadingSelects(); }
  else c.innerHTML = genericPanel(activePage, '📄');
}

document.getElementById('roleSelect').onchange = e=>{
  role = e.target.value;
  activePage = 'za_nav_dashboard';
  render();
};

// i18n.js calls applyTranslations() on DOMContentLoaded for static
// [data-i18n] elements, and window.onSisLangChange() (if defined) after
// every setLang() call so dynamically-built content re-renders too.
window.onSisLangChange = render;
document.addEventListener('DOMContentLoaded', render);
