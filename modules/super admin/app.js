/* This file relies on i18n.js being loaded first (t, applyTranslations,
   getCurrentLang, window.setLang) — see index.html script order.

   Mirrors the Zonal Admin portal's app.js conventions exactly (same
   apiGet/apiPost helpers, same showConfirm/showPasswordConfirm/
   showCredentialsModal modals, same panel/table/form-grid CSS classes)
   so the two portals feel like the same product — just pointed at
   /api/super/* and /api/registrar/pending-roster instead of /api/zonal/*.
   Auth is the httpOnly `auth_token` cookie set at login, same as every
   other portal in this system. */
const API_BASE = '';

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
async function apiPost(path, body) { return apiSend('POST', path, body); }
async function apiPut(path, body) { return apiSend('PUT', path, body); }
async function apiDelete(path) { return apiSend('DELETE', path); }
async function apiSend(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method, credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (res.status === 401) { handleUnauthorized(); throw new Error('Not logged in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
// Roster upload is multipart, not JSON — separate from apiSend above,
// which always sends Content-Type: application/json.
async function apiUpload(path, formData) {
  const res = await fetch(API_BASE + path, { method: 'POST', credentials: 'include', body: formData });
  if (res.status === 401) { handleUnauthorized(); throw new Error('Not logged in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------------- Styled confirm dialog (same as Zonal Admin's) ------ */
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
    const finish = (result) => { if (done) return; done = true; backdrop.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) finish(false); });
    backdrop.querySelector('#confirmModalCancel').addEventListener('click', () => finish(false));
    backdrop.querySelector('#confirmModalOk').addEventListener('click', () => finish(true));
    backdrop.querySelector('#confirmModalOk').focus();
  });
}

/* ---------------- Password-confirm modal ------------------------------
   Same "prove it's you" gate as the Zonal Admin portal, just checked
   against POST /api/super/verify-password instead of /api/zonal/... —
   gates every write in this portal (create zonal admin, school setup,
   subject dictionary, roster upload), with NO approval step behind it;
   this password check is the only gate. */
function showPasswordConfirm(message) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="pwConfirmTitle" aria-describedby="pwConfirmMsg">
        <div class="confirm-modal-icon"><i data-lucide="lock"></i></div>
        <h3 class="confirm-modal-title" id="pwConfirmTitle">${t('za_pwconfirm_title')}</h3>
        <p class="confirm-modal-msg" id="pwConfirmMsg">${message || t('za_pwconfirm_hint')}</p>
        <div class="form-field" style="text-align:left;margin-bottom:4px;">
          <label for="pwConfirmInput" class="sr-only-label">${t('za_pwconfirm_placeholder')}</label>
          <input type="password" id="pwConfirmInput" autocomplete="current-password" placeholder="${t('za_pwconfirm_placeholder')}">
        </div>
        <p class="confirm-modal-error" id="pwConfirmError" role="alert" aria-live="assertive" style="display:none"></p>
        <div class="confirm-modal-actions">
          <button class="btn ghost" id="pwConfirmCancel">${t('za_cancel')}</button>
          <button class="btn primary" id="pwConfirmOk">${t('za_confirm_yes')}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    if (window.lucide) lucide.createIcons();
    const input = backdrop.querySelector('#pwConfirmInput');
    const errEl = backdrop.querySelector('#pwConfirmError');
    const okBtn = backdrop.querySelector('#pwConfirmOk');
    const cancelBtn = backdrop.querySelector('#pwConfirmCancel');
    let done = false;
    const finish = (result) => { if (done) return; done = true; backdrop.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); if (e.key === 'Enter' && document.activeElement === input) attempt(); };
    document.addEventListener('keydown', onKey);
    const attempt = async () => {
      const password = input.value;
      errEl.style.display = 'none';
      if (!password) { errEl.textContent = t('za_pwconfirm_required'); errEl.style.display = 'block'; input.focus(); return; }
      okBtn.disabled = true;
      const originalText = okBtn.textContent;
      okBtn.textContent = t('za_loading');
      try {
        await apiPost('/api/super/verify-password', { password });
        finish(true);
      } catch (err) {
        errEl.textContent = err.message || t('za_pwconfirm_wrong');
        errEl.style.display = 'block';
        okBtn.disabled = false;
        okBtn.textContent = originalText;
        input.select(); input.focus();
      }
    };
    backdrop.addEventListener('click', e => { if (e.target === backdrop) finish(false); });
    cancelBtn.addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', attempt);
    input.focus();
  });
}

/* ---------------- Credentials modal (same as Zonal Admin's) ---------- */
function showCredentialsModal(id, password) {
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
  backdrop.querySelector('#credsCopyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`ID: ${id}\n${t('za_f_password')}: ${password}`);
      const btn = backdrop.querySelector('#credsCopyBtn');
      btn.textContent = t('za_saved');
      setTimeout(() => { if (btn.isConnected) btn.textContent = t('za_creds_copy'); }, 1500);
    } catch (e) { /* clipboard denied — the visible text is still there to copy by hand */ }
  });
}

function setMsg(el, text, kind) {
  if (!el) return;
  const icon = kind === 'success' ? 'check-circle-2' : 'alert-triangle';
  el.innerHTML = `<i data-lucide="${icon}" class="msg-icon ${kind}"></i><span>${text}</span>`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  if (window.lucide) lucide.createIcons();
}
function setSuccessMsg(el, text) { setMsg(el, text, 'success'); }
function setErrorMsg(el, text) { setMsg(el, text, 'error'); }

function errorPanel(err) {
  const msg = (err && err.message) || String(err);
  return `<div class="panel"><div class="alert-box error">
    <div class="icon"><i data-lucide="alert-triangle"></i></div>
    <div class="body">${msg}</div>
  </div></div>`;
}

function initialsOf(name) {
  if (!name) return 'SA';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || parts[0].slice(0, 2).toUpperCase();
}

function fillSelect(el, rows, idKey, nameKey, placeholder) {
  el.innerHTML = `<option value="">${placeholder}</option>` +
    rows.map(r => `<option value="${r[idKey]}">${r[nameKey]}</option>`).join('');
}

let role = null;
let CURRENT_USER = null;
let activePage = 'sa_nav_dashboard';

/* ---------------- Nav — single role, no title branching --------------- */
const NAV_SUPER = [
  { sec: 'sa_sec_admin', items: [
    ['sa_nav_dashboard', 'home'],
    ['sa_nav_regions', 'map'],
    ['sa_nav_zonal_admins', 'user-cog'],
    ['sa_nav_schools', 'building-2'],
    ['sa_nav_subjects', 'book-open'],
    ['sa_nav_roster', 'upload'],
    ['sa_nav_audit', 'scroll-text']
  ]}
];

const SCHOOL_LEVELS = ['BASIC', 'CORE', 'GENERAL', 'PREPARATORY'];
const SCHOOL_LEVEL_GRADES = { BASIC: '1–6', CORE: '7–8', GENERAL: '9–10', PREPARATORY: '11–12' };
const SCHOOL_STREAMS = ['NATURAL SCIENCE', 'SOCIAL SCIENCE'];

function navHasPage(key) {
  return NAV_SUPER.some(section => section.items.some(([k]) => k === key));
}

function renderNav() {
  const wrap = document.getElementById('navScroll');
  wrap.innerHTML = '';
  NAV_SUPER.forEach(section => {
    const lbl = document.createElement('div');
    lbl.className = 'nav-label'; lbl.textContent = t(section.sec);
    wrap.appendChild(lbl);
    section.items.forEach(([key, icon]) => {
      const el = document.createElement('div');
      el.className = 'nav-item' + (key === activePage ? ' active' : '');
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      if (key === activePage) el.setAttribute('aria-current', 'page');
      el.innerHTML = `<span class="ic"><i data-lucide="${icon}"></i></span><span class="nav-item-label">${t(key)}</span>`;
      const go = () => { activePage = key; render(); closeMobileNav(); };
      el.onclick = go;
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      wrap.appendChild(el);
    });
  });
}

function openMobileNav() { document.getElementById('sidebar').classList.add('open'); document.getElementById('navOverlay').classList.add('open'); }
function closeMobileNav() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('navOverlay').classList.remove('open'); }

function renderTopChrome() {
  const name = CURRENT_USER.admin_full_name || t('sa_role_title');
  document.getElementById('roleTitleTxt').textContent = t('sa_role_title');
  document.getElementById('roleIdTxt').textContent = CURRENT_USER.user_id;
  document.getElementById('whoName').textContent = name;
  document.getElementById('whoRole').textContent = t('sa_role_title');
  const avatarEl = document.getElementById('avatarInit');
  if (avatarEl) avatarEl.textContent = initialsOf(name);
  document.getElementById('pageTitle').textContent = t(activePage);
}

function genericPanel(titleKey, icon) {
  return `<div class="panel"><h3><i data-lucide="${icon}"></i> ${t(titleKey)}</h3>
    <p class="hint">${t('za_generic_hint')}</p></div>`;
}

/* ==================================================================
   Dashboard — headline numbers from /api/super/stats, a DB/health
   check from /api/super/system-status, recently registered schools,
   and the last few rows of the activity log as a "what's happened
   recently" feed.
   ================================================================== */
function dashboardSkeletonHTML() {
  return `<div class="panel" id="dashDataPanel"><p class="hint">${t('za_loading')}</p></div>`;
}
async function loadAndRenderDashboard() {
  try {
    const [stats, status, schools, activity] = await Promise.all([
      apiGet('/api/super/stats'),
      apiGet('/api/super/system-status'),
      apiGet('/api/super/schools'),
      apiGet('/api/super/audit-log', { limit: 8 })
    ]);
    const cards = [
      { icon: 'building-2', label: t('sa_dash_schools'), value: stats.total_schools },
      { icon: 'map', label: t('sa_dash_regions'), value: stats.total_regions },
      { icon: 'compass', label: t('sa_dash_zones'), value: stats.total_zones },
      { icon: 'users', label: t('sa_dash_students'), value: stats.total_students },
      { icon: 'graduation-cap', label: t('sa_dash_hoe'), value: stats.total_hoe },
      { icon: 'user-cog', label: t('sa_dash_tdc'), value: stats.total_tdc }
    ];
    const recentSchools = schools.slice(0, 6).map(s => `
      <tr><td>${s.school_name}</td><td>${t('sa_level_' + s.school_level.toLowerCase())}</td><td>${s.zone_name || '—'}</td></tr>`).join('')
      || `<tr><td colspan="3" class="hint">${t('sa_schools_empty')}</td></tr>`;
    const activityRows = activity.length ? activity.map(a => `
      <tr><td>${a.action}</td><td>${a.actor_id}</td><td>${new Date(a.created_at).toLocaleString()}</td></tr>`).join('')
      : `<tr><td colspan="3" class="hint">${t('sa_audit_empty')}</td></tr>`;

    document.getElementById('content').innerHTML = `
      <div class="cards">
        ${cards.map(c => `
          <div class="card">
            <div class="icon"><i data-lucide="${c.icon}"></i></div>
            <div><div class="label">${c.label}</div>
            <div class="value">${c.value}</div></div>
          </div>`).join('')}
      </div>
      <div class="panel">
        <h3><i data-lucide="activity"></i> ${t('sa_dash_system_status')}</h3>
        <div class="cards">
          <div class="card">
            <div class="icon"><i data-lucide="database"></i></div>
            <div><div class="label">${t('sa_status_db')}</div>
            <div class="value" style="font-size:16px;">${status.database.ok ? t('sa_status_ok') : t('sa_status_down')} (${status.database.latency_ms}ms)</div></div>
          </div>
          <div class="card">
            <div class="icon"><i data-lucide="clock"></i></div>
            <div><div class="label">${t('sa_status_uptime')}</div>
            <div class="value" style="font-size:16px;">${Math.floor(status.server.uptime_seconds / 3600)}h ${Math.floor((status.server.uptime_seconds % 3600) / 60)}m</div></div>
          </div>
          <div class="card">
            <div class="icon"><i data-lucide="plug-zap"></i></div>
            <div><div class="label">${t('sa_status_api')}</div>
            <div class="value" style="font-size:16px;">${status.api.ok ? t('sa_status_ok') : t('sa_status_down')}</div></div>
          </div>
        </div>
      </div>
      <div class="panel">
        <h3><i data-lucide="building-2"></i> ${t('sa_dash_recent_schools')}</h3>
        <div class="table-wrap"><table>
          <tr><th>${t('sa_th_school')}</th><th>${t('sa_th_level')}</th><th>${t('sa_th_zone')}</th></tr>
          ${recentSchools}
        </table></div>
      </div>
      <div class="panel">
        <h3><i data-lucide="scroll-text"></i> ${t('sa_dash_recent_activity')}</h3>
        <div class="table-wrap"><table>
          <tr><th>${t('sa_th_action')}</th><th>${t('sa_th_actor')}</th><th>${t('sa_th_when')}</th></tr>
          ${activityRows}
        </table></div>
      </div>`;
  } catch (err) {
    const panel = document.getElementById('dashDataPanel');
    if (panel) panel.outerHTML = errorPanel(err);
    else document.getElementById('content').innerHTML = errorPanel(err);
  }
}

/* ==================================================================
   Regions — the top of the hierarchy; add/edit/remove, live from
   /api/super/regions (write) and /api/super/lookup/regions (read).
   ================================================================== */
function regionsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="map"></i> ${t('sa_nav_regions')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}
async function loadAndRenderRegions() {
  try {
    const regions = await apiGet('/api/super/lookup/regions');
    renderRegionsPanel(regions);
  } catch (err) {
    document.getElementById('content').innerHTML = errorPanel(err);
  }
}
function renderRegionsPanel(regions) {
  const rows = regions.length ? regions.map(r => `
    <tr data-id="${r.region_id}">
      <td class="region-name">${r.region_name}</td>
      <td>
        <button class="btn ghost sm region-edit">${t('za_edit')}</button>
        <button class="btn ghost sm region-delete">${t('za_delete')}</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="2" class="hint">${t('sa_regions_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="map"></i> ${t('sa_nav_regions')}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="region_new_name">${t('sa_f_region_name')}</label>
        <input type="text" id="region_new_name" placeholder="${t('sa_f_region_name')}">
      </div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnAddRegion">${t('sa_add_region')}</button>
    </div>
    <p class="hint" id="regionFormMsg"></p>
    <div class="table-wrap"><table>
      <tr><th>${t('sa_th_region')}</th><th>${t('za_th_actions')}</th></tr>
      ${rows}
    </table></div>
  </div>`;

  const msg = document.getElementById('regionFormMsg');
  document.getElementById('btnAddRegion').onclick = async () => {
    const nameEl = document.getElementById('region_new_name');
    const region_name = nameEl.value.trim();
    if (!region_name) { setErrorMsg(msg, t('sa_region_required')); return; }
    if (!(await showPasswordConfirm(t('sa_pwconfirm_region')))) return;
    try {
      const result = await apiPost('/api/super/regions', { region_name });
      setSuccessMsg(msg, result.message);
      loadAndRenderRegions();
    } catch (err) { setErrorMsg(msg, err.message); }
  };

  document.querySelectorAll('.region-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      const current = tr.querySelector('.region-name').textContent;
      const next = prompt(t('sa_edit_region_prompt'), current);
      if (next === null || !next.trim() || next.trim() === current) return;
      if (!(await showPasswordConfirm(t('sa_pwconfirm_region')))) return;
      try {
        await apiPut(`/api/super/regions/${id}`, { region_name: next.trim() });
        loadAndRenderRegions();
      } catch (err) { setErrorMsg(msg, err.message); }
    });
  });
  document.querySelectorAll('.region-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      if (!(await showConfirm(t('sa_confirm_delete_region')))) return;
      if (!(await showPasswordConfirm(t('sa_pwconfirm_region')))) return;
      try {
        await apiDelete(`/api/super/regions/${id}`);
        loadAndRenderRegions();
      } catch (err) { setErrorMsg(msg, err.message); }
    });
  });
}

/* ==================================================================
   Zonal Admins — create Head of Education / Teacher Development
   Coordinator accounts and assign them to a Region -> Zone, live from
   /api/super/zonal-admins and /api/super/lookup/{regions,zones}.
   ================================================================== */
function zonalAdminsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="user-cog"></i> ${t('sa_nav_zonal_admins')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}
async function loadAndRenderZonalAdmins() {
  try {
    const [admins, regions] = await Promise.all([
      apiGet('/api/super/zonal-admins'),
      apiGet('/api/super/lookup/regions')
    ]);
    renderZonalAdminsPanel(admins, regions);
  } catch (err) {
    document.getElementById('content').innerHTML = errorPanel(err);
  }
}
function renderZonalAdminsPanel(admins, regions) {
  const rows = admins.length ? admins.map(a => `
    <tr data-id="${a.admin_id}">
      <td>${[a.first_name, a.middle_name, a.last_name].filter(Boolean).join(' ')}</td>
      <td>${a.admin_id}</td>
      <td>${t(a.title === 'Head of Education' ? 'za_role_hoe' : 'za_role_tdc')}</td>
      <td>${a.zone_name || '—'}</td>
      <td>${a.region_name || '—'}</td>
      <td>
        <button class="btn ghost sm za-edit">${t('za_edit')}</button>
        <button class="btn ghost sm za-reset">${t('sa_reset_password')}</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="6" class="hint">${t('sa_zonal_admins_empty')}</td></tr>`;
  const regionOpts = regions.map(r => `<option value="${r.region_id}">${r.region_name}</option>`).join('');
  const adminsByAdminId = Object.fromEntries(admins.map(a => [a.admin_id, a]));

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="user-plus"></i> ${t('sa_create_zonal_admin')}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="za_title">${t('sa_f_title')}</label>
        <select id="za_title">
          <option value="Head of Education">${t('za_role_hoe')}</option>
          <option value="Teacher Development Coordinator">${t('za_role_tdc')}</option>
        </select>
      </div>
      <div class="form-field">
        <label for="za_region">${t('za_f_region')}</label>
        <select id="za_region"><option value="">${t('za_pick_region')}</option>${regionOpts}</select>
      </div>
      <div class="form-field">
        <label for="za_zone">${t('za_f_zone')}</label>
        <select id="za_zone" disabled><option value="">${t('za_pick_zone')}</option></select>
      </div>
      <div class="form-field">
        <label for="za_first">${t('sa_f_first_name')}</label>
        <input type="text" id="za_first" placeholder="${t('sa_f_first_name')}">
      </div>
      <div class="form-field">
        <label for="za_middle">${t('sa_f_middle_name')}</label>
        <input type="text" id="za_middle" placeholder="${t('sa_f_middle_name')}">
      </div>
      <div class="form-field">
        <label for="za_last">${t('sa_f_last_name')}</label>
        <input type="text" id="za_last" placeholder="${t('sa_f_last_name')}">
      </div>
      <div class="form-field">
        <label for="za_contact">${t('sa_f_contact')}</label>
        <input type="text" id="za_contact" placeholder="09xxxxxxxx">
      </div>
      <div class="form-field">
        <label for="za_email">${t('sa_f_email')}</label>
        <input type="email" id="za_email" placeholder="name@example.com">
      </div>
    </div>
    <div class="form-field" id="za_delegate_wrap" style="display:none;">
      <label class="checklist-row"><input type="checkbox" id="za_delegate"> ${t('sa_f_can_act_independently')}</label>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnCreateZonalAdmin">${t('sa_create_zonal_admin')}</button>
    </div>
    <p class="hint" id="zonalAdminFormMsg"></p>
  </div>
  <div class="panel">
    <h3><i data-lucide="user-cog"></i> ${t('sa_nav_zonal_admins')}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t('sa_th_name')}</th><th>${t('sa_th_id')}</th><th>${t('sa_th_title')}</th><th>${t('sa_th_zone')}</th><th>${t('sa_th_region')}</th><th>${t('za_th_actions')}</th></tr>
      ${rows}
    </table></div>
  </div>`;

  const regionEl = document.getElementById('za_region');
  const zoneEl = document.getElementById('za_zone');
  const titleEl = document.getElementById('za_title');
  const delegateWrap = document.getElementById('za_delegate_wrap');
  const updateDelegateVisibility = () => { delegateWrap.style.display = titleEl.value === 'Teacher Development Coordinator' ? 'block' : 'none'; };
  titleEl.addEventListener('change', updateDelegateVisibility);
  updateDelegateVisibility();

  regionEl.addEventListener('change', async () => {
    fillSelect(zoneEl, [], 'zone_id', 'zone_name', t('za_pick_zone')); zoneEl.disabled = true;
    if (!regionEl.value) return;
    try {
      const zones = await apiGet('/api/super/lookup/zones', { region_id: regionEl.value });
      fillSelect(zoneEl, zones, 'zone_id', 'zone_name', t('za_pick_zone'));
      zoneEl.disabled = zones.length === 0;
    } catch (err) { setErrorMsg(document.getElementById('zonalAdminFormMsg'), err.message); }
  });

  document.getElementById('btnCreateZonalAdmin').onclick = async () => {
    const msg = document.getElementById('zonalAdminFormMsg');
    const body = {
      title: titleEl.value,
      zone_id: zoneEl.value || null,
      first_name: document.getElementById('za_first').value.trim(),
      middle_name: document.getElementById('za_middle').value.trim() || null,
      last_name: document.getElementById('za_last').value.trim(),
      contact_number: document.getElementById('za_contact').value.trim() || null,
      email: document.getElementById('za_email').value.trim() || null,
      can_act_independently: titleEl.value === 'Teacher Development Coordinator' && document.getElementById('za_delegate').checked
    };
    if (!body.zone_id || !body.first_name || !body.last_name) {
      setErrorMsg(msg, t('sa_zonal_admin_required'));
      return;
    }
    if (!(await showPasswordConfirm(t('sa_pwconfirm_zonal_admin')))) return;
    try {
      const result = await apiPost('/api/super/zonal-admins', body);
      setSuccessMsg(msg, result.message);
      showCredentialsModal(result.admin_id, result.default_password);
      loadAndRenderZonalAdmins();
    } catch (err) { setErrorMsg(msg, err.message); }
  };

  document.querySelectorAll('.za-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const adminId = btn.closest('tr').dataset.id;
      openZonalAdminEditModal(adminsByAdminId[adminId]);
    });
  });
  document.querySelectorAll('.za-reset').forEach(btn => {
    btn.addEventListener('click', async () => {
      const adminId = btn.closest('tr').dataset.id;
      if (!(await showConfirm(t('sa_confirm_reset_password')))) return;
      if (!(await showPasswordConfirm(t('sa_pwconfirm_reset')))) return;
      try {
        const result = await apiPost(`/api/super/zonal-admins/${adminId}/reset-password`, {});
        showCredentialsModal(adminId, result.default_password);
      } catch (err) { alert(err.message); }
    });
  });
}

// A small edit modal for one zonal admin — name/contact/email plus the
// TDC-only delegation toggle. Zone and title aren't editable here (see
// the PUT route's comment: both are baked into admin_id).
function openZonalAdminEditModal(admin) {
  const backdrop = document.createElement('div');
  backdrop.className = 'confirm-modal-backdrop';
  const isTdc = admin.title === 'Teacher Development Coordinator';
  backdrop.innerHTML = `
    <div class="confirm-modal" role="dialog" aria-modal="true">
      <div class="confirm-modal-icon"><i data-lucide="user-cog"></i></div>
      <h3 class="confirm-modal-title">${t('sa_edit_zonal_admin')}</h3>
      <div class="form-grid">
        <div class="form-field"><label for="zaEditFirst">${t('sa_f_first_name')}</label><input type="text" id="zaEditFirst" value="${admin.first_name}"></div>
        <div class="form-field"><label for="zaEditMiddle">${t('sa_f_middle_name')}</label><input type="text" id="zaEditMiddle" value="${admin.middle_name || ''}"></div>
        <div class="form-field"><label for="zaEditLast">${t('sa_f_last_name')}</label><input type="text" id="zaEditLast" value="${admin.last_name}"></div>
        <div class="form-field"><label for="zaEditContact">${t('sa_f_contact')}</label><input type="text" id="zaEditContact" value="${admin.contact_number || ''}"></div>
        <div class="form-field"><label for="zaEditEmail">${t('sa_f_email')}</label><input type="email" id="zaEditEmail" value="${admin.email || ''}"></div>
      </div>
      ${isTdc ? `<div class="form-field"><label class="checklist-row"><input type="checkbox" id="zaEditDelegate" ${admin.can_act_independently ? 'checked' : ''}> ${t('sa_f_can_act_independently')}</label></div>` : ''}
      <p class="confirm-modal-error" id="zaEditError" role="alert" style="display:none"></p>
      <div class="confirm-modal-actions">
        <button class="btn ghost" id="zaEditCancel">${t('za_cancel')}</button>
        <button class="btn primary" id="zaEditSave">${t('za_save')}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (window.lucide) lucide.createIcons();
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('#zaEditCancel').addEventListener('click', close);
  backdrop.querySelector('#zaEditSave').addEventListener('click', async () => {
    const errEl = backdrop.querySelector('#zaEditError');
    const body = {
      first_name: backdrop.querySelector('#zaEditFirst').value.trim(),
      middle_name: backdrop.querySelector('#zaEditMiddle').value.trim() || null,
      last_name: backdrop.querySelector('#zaEditLast').value.trim(),
      contact_number: backdrop.querySelector('#zaEditContact').value.trim() || null,
      email: backdrop.querySelector('#zaEditEmail').value.trim() || null,
      can_act_independently: isTdc ? backdrop.querySelector('#zaEditDelegate').checked : admin.can_act_independently
    };
    if (!body.first_name || !body.last_name) {
      errEl.textContent = t('sa_zonal_admin_required'); errEl.style.display = 'block';
      return;
    }
    close();
    if (!(await showPasswordConfirm(t('sa_pwconfirm_zonal_admin_edit')))) return;
    try {
      await apiPut(`/api/super/zonal-admins/${admin.admin_id}`, body);
      loadAndRenderZonalAdmins();
    } catch (err) { alert(err.message); }
  });
}

/* ==================================================================
   Schools — setup (name, level, region/zone/woreda/kebele, streams)
   and a list of every school across every zone. School-level prefix
   preview mirrors buildSchoolPrefixBase() in server.js, same pattern
   the old Zonal Admin setup form used.
   ================================================================== */
function schoolsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="building-2"></i> ${t('sa_nav_schools')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}
const SCHOOL_LEVEL_CODE = { BASIC: 'BS', CORE: 'CR', GENERAL: 'GN', PREPARATORY: 'PR' };
function computeSchoolPrefixPreview(name, level) {
  const initials = name.trim().split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('');
  if (!initials || !level) return '';
  return initials + (SCHOOL_LEVEL_CODE[level] || '');
}
async function loadAndRenderSchools() {
  try {
    const [schools, regions] = await Promise.all([
      apiGet('/api/super/schools'),
      apiGet('/api/super/lookup/regions')
    ]);
    renderSchoolsPanel(schools, regions);
  } catch (err) {
    document.getElementById('content').innerHTML = errorPanel(err);
  }
}
function renderSchoolsPanel(schools, regions) {
  const rows = schools.length ? schools.map(s => `
    <tr>
      <td>${s.school_name}</td>
      <td><span class="badge">${t('sa_level_' + s.school_level.toLowerCase())} (${SCHOOL_LEVEL_GRADES[s.school_level] || ''})</span></td>
      <td>${s.school_prefix || '—'}</td>
      <td>${s.zone_name || '—'}</td>
      <td>${s.region_name || '—'}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="hint">${t('sa_schools_empty')}</td></tr>`;
  const regionOpts = regions.map(r => `<option value="${r.region_id}">${r.region_name}</option>`).join('');
  const levelOpts = SCHOOL_LEVELS.map(l => `<option value="${l}">${t('sa_level_' + l.toLowerCase())} (${SCHOOL_LEVEL_GRADES[l]})</option>`).join('');
  const streamChecks = SCHOOL_STREAMS.map(s => `
    <label class="checklist-row"><input type="checkbox" class="school-stream-check" value="${s}"> ${t('sa_stream_' + s.toLowerCase().replace(' ', '_'))}</label>`).join('');

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="plus-circle"></i> ${t('sa_setup_school')}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="sc_name">${t('za_f_school_name')}</label>
        <input type="text" id="sc_name" placeholder="e.g. Newland">
      </div>
      <div class="form-field">
        <label for="sc_level">${t('za_f_school_level')}</label>
        <select id="sc_level"><option value="">${t('za_pick_school_level')}</option>${levelOpts}</select>
      </div>
      <div class="form-field">
        <label for="sc_prefix_preview">${t('za_f_school_prefix')}</label>
        <input type="text" id="sc_prefix_preview" placeholder="—" readonly disabled>
      </div>
      <div class="form-field">
        <label for="sc_moe">${t('za_f_moe_code')}</label>
        <input type="text" id="sc_moe" placeholder="e.g. 1203010102">
      </div>
      <div class="form-field">
        <label for="sc_region">${t('za_f_region')}</label>
        <select id="sc_region"><option value="">${t('za_pick_region')}</option>${regionOpts}</select>
      </div>
      <div class="form-field">
        <label for="sc_zone">${t('za_f_zone')}</label>
        <select id="sc_zone" disabled><option value="">${t('za_pick_zone')}</option></select>
      </div>
      <div class="form-field">
        <label for="sc_woreda">${t('za_f_woreda')}</label>
        <select id="sc_woreda" disabled><option value="">${t('za_pick_woreda')}</option></select>
      </div>
      <div class="form-field">
        <label for="sc_kebele">${t('za_f_kebele')}</label>
        <select id="sc_kebele" disabled><option value="">${t('za_pick_kebele')}</option></select>
      </div>
    </div>
    <div class="form-field" id="sc_streams_wrap" style="display:none;">
      <label>${t('sa_f_streams')}</label>
      <div class="checklist">${streamChecks}</div>
      <p class="hint">${t('sa_streams_hint')}</p>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnSaveSchool">${t('za_save_school')}</button>
    </div>
    <p class="hint" id="schoolFormMsg"></p>
  </div>
  <div class="panel">
    <h3><i data-lucide="building-2"></i> ${t('sa_all_schools')}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t('sa_th_school')}</th><th>${t('sa_th_level')}</th><th>${t('za_th_prefix')}</th><th>${t('sa_th_zone')}</th><th>${t('za_th_region')}</th></tr>
      ${rows}
    </table></div>
  </div>`;

  const nameEl = document.getElementById('sc_name');
  const levelEl = document.getElementById('sc_level');
  const previewEl = document.getElementById('sc_prefix_preview');
  const streamsWrap = document.getElementById('sc_streams_wrap');
  const updatePreview = () => {
    previewEl.value = computeSchoolPrefixPreview(nameEl.value, levelEl.value);
    streamsWrap.style.display = levelEl.value === 'PREPARATORY' ? 'block' : 'none';
  };
  nameEl.addEventListener('input', updatePreview);
  levelEl.addEventListener('change', updatePreview);

  const regionEl = document.getElementById('sc_region');
  const zoneEl = document.getElementById('sc_zone');
  const woredaEl = document.getElementById('sc_woreda');
  const kebeleEl = document.getElementById('sc_kebele');
  const formMsg = document.getElementById('schoolFormMsg');

  regionEl.addEventListener('change', async () => {
    fillSelect(zoneEl, [], 'zone_id', 'zone_name', t('za_pick_zone')); zoneEl.disabled = true;
    fillSelect(woredaEl, [], 'woreda_id', 'woreda_name', t('za_pick_woreda')); woredaEl.disabled = true;
    fillSelect(kebeleEl, [], 'kebele_id', 'kebele_name', t('za_pick_kebele')); kebeleEl.disabled = true;
    if (!regionEl.value) return;
    try {
      const zones = await apiGet('/api/super/lookup/zones', { region_id: regionEl.value });
      fillSelect(zoneEl, zones, 'zone_id', 'zone_name', t('za_pick_zone'));
      zoneEl.disabled = zones.length === 0;
    } catch (err) { setErrorMsg(formMsg, err.message); }
  });
  zoneEl.addEventListener('change', async () => {
    fillSelect(woredaEl, [], 'woreda_id', 'woreda_name', t('za_pick_woreda')); woredaEl.disabled = true;
    fillSelect(kebeleEl, [], 'kebele_id', 'kebele_name', t('za_pick_kebele')); kebeleEl.disabled = true;
    if (!zoneEl.value) return;
    try {
      const woredas = await apiGet('/api/super/lookup/woredas', { zone_id: zoneEl.value });
      fillSelect(woredaEl, woredas, 'woreda_id', 'woreda_name', t('za_pick_woreda'));
      woredaEl.disabled = woredas.length === 0;
    } catch (err) { setErrorMsg(formMsg, err.message); }
  });
  woredaEl.addEventListener('change', async () => {
    fillSelect(kebeleEl, [], 'kebele_id', 'kebele_name', t('za_pick_kebele')); kebeleEl.disabled = true;
    if (!woredaEl.value) return;
    try {
      const kebeles = await apiGet('/api/super/lookup/kebeles', { woreda_id: woredaEl.value });
      fillSelect(kebeleEl, kebeles, 'kebele_id', 'kebele_name', t('za_pick_kebele'));
      kebeleEl.disabled = kebeles.length === 0;
    } catch (err) { setErrorMsg(formMsg, err.message); }
  });

  document.getElementById('btnSaveSchool').onclick = async () => {
    const body = {
      school_name: nameEl.value.trim(),
      school_level: levelEl.value,
      moe_school_code: document.getElementById('sc_moe').value.trim() || null,
      region_id: regionEl.value || null,
      zone_id: zoneEl.value || null,
      woreda_id: woredaEl.value || null,
      kebele_id: kebeleEl.value || null,
      streams: levelEl.value === 'PREPARATORY'
        ? Array.from(document.querySelectorAll('.school-stream-check:checked')).map(c => c.value)
        : undefined
    };
    if (!body.school_name || !body.school_level || !body.zone_id) {
      setErrorMsg(formMsg, t('za_setup_required'));
      return;
    }
    if (!(await showPasswordConfirm(t('za_pwconfirm_setup_school')))) return;
    try {
      const result = await apiPost('/api/super/schools', body);
      setSuccessMsg(formMsg, result.message);
      loadAndRenderSchools();
    } catch (err) { setErrorMsg(formMsg, err.message); }
  };
}

/* ==================================================================
   Subject Dictionary — GLOBAL catalogue, filtered by level (and, for
   PREPARATORY, optionally by stream), live from
   /api/super/subject-dictionary. No approval step — every write is
   gated by showPasswordConfirm only.
   ================================================================== */
let subjectsCurrentLevel = null;
let subjectsCurrentStream = '';
function subjectsSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="book-open"></i> ${t('sa_nav_subjects')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}
async function loadAndRenderSubjects() {
  renderSubjectsPanel();
}
function renderSubjectsPanel() {
  const levelOpts = SCHOOL_LEVELS.map(l => `<option value="${l}" ${l === subjectsCurrentLevel ? 'selected' : ''}>${t('sa_level_' + l.toLowerCase())} (${SCHOOL_LEVEL_GRADES[l]})</option>`).join('');
  const streamOpts = SCHOOL_STREAMS.map(s => `<option value="${s}" ${s === subjectsCurrentStream ? 'selected' : ''}>${t('sa_stream_' + s.toLowerCase().replace(' ', '_'))}</option>`).join('');

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="book-open"></i> ${t('sa_nav_subjects')}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="subj_level">${t('sa_f_subject_level')}</label>
        <select id="subj_level"><option value="">${t('sa_pick_level')}</option>${levelOpts}</select>
      </div>
      <div class="form-field" id="subj_stream_wrap" style="display:none;">
        <label for="subj_stream_filter">${t('sa_th_stream')}</label>
        <select id="subj_stream_filter"><option value="">${t('sa_f_subject_stream_both')}</option>${streamOpts}</select>
      </div>
    </div>
    <div id="subjectsBody">
      ${subjectsCurrentLevel ? '' : `<p class="hint">${t('sa_pick_level_first')}</p>`}
    </div>
  </div>`;

  const levelEl = document.getElementById('subj_level');
  const streamWrap = document.getElementById('subj_stream_wrap');
  const streamEl = document.getElementById('subj_stream_filter');
  const updateStreamVisibility = () => { streamWrap.style.display = levelEl.value === 'PREPARATORY' ? 'block' : 'none'; };
  updateStreamVisibility();

  const refresh = async () => {
    if (!subjectsCurrentLevel) {
      document.getElementById('subjectsBody').innerHTML = `<p class="hint">${t('sa_pick_level_first')}</p>`;
      return;
    }
    try {
      const params = { school_level: subjectsCurrentLevel };
      if (subjectsCurrentLevel === 'PREPARATORY' && subjectsCurrentStream) params.stream = subjectsCurrentStream;
      const subs = await apiGet('/api/super/subject-dictionary', params);
      renderSubjectsBody(subs);
    } catch (err) {
      document.getElementById('subjectsBody').innerHTML = errorPanel(err);
    }
  };

  levelEl.addEventListener('change', () => {
    subjectsCurrentLevel = levelEl.value || null;
    subjectsCurrentStream = '';
    streamEl.value = '';
    updateStreamVisibility();
    refresh();
  });
  streamEl.addEventListener('change', () => {
    subjectsCurrentStream = streamEl.value || '';
    refresh();
  });

  if (subjectsCurrentLevel) refresh();
}
function renderSubjectsBody(subjects) {
  const rows = subjects.length ? subjects.map(s => `
    <tr data-id="${s.subject_dict_id}">
      <td class="subj-name">${s.subject_name}</td>
      <td>${s.stream ? t('sa_stream_' + s.stream.toLowerCase().replace(' ', '_')) : t('sa_f_subject_stream_both')}</td>
      <td>
        <button class="btn ghost sm subj-edit">${t('za_edit')}</button>
        <button class="btn ghost sm subj-delete">${t('za_delete')}</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="3" class="hint">${t('sa_subjects_empty')}</td></tr>`;

  const showStreamField = subjectsCurrentLevel === 'PREPARATORY';
  const newStreamOpts = SCHOOL_STREAMS.map(s => `<option value="${s}">${t('sa_stream_' + s.toLowerCase().replace(' ', '_'))}</option>`).join('');

  document.getElementById('subjectsBody').innerHTML = `
    <div class="form-grid">
      <div class="form-field">
        <label for="subj_new_name">${t('sa_f_subject_name')}</label>
        <input type="text" id="subj_new_name" placeholder="${t('sa_f_subject_name')}">
      </div>
      ${showStreamField ? `
      <div class="form-field">
        <label for="subj_new_stream">${t('sa_f_subject_stream')}</label>
        <select id="subj_new_stream"><option value="">${t('sa_f_subject_stream_both')}</option>${newStreamOpts}</select>
      </div>` : ''}
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnAddSubject">${t('sa_add_subject')}</button>
    </div>
    <p class="hint" id="subjectFormMsg"></p>
    <div class="table-wrap"><table>
      <tr><th>${t('sa_th_subject')}</th><th>${t('sa_th_stream')}</th><th>${t('za_th_actions')}</th></tr>
      ${rows}
    </table></div>`;

  const msg = document.getElementById('subjectFormMsg');
  const refreshBody = async () => {
    const params = { school_level: subjectsCurrentLevel };
    if (subjectsCurrentLevel === 'PREPARATORY' && subjectsCurrentStream) params.stream = subjectsCurrentStream;
    const subs = await apiGet('/api/super/subject-dictionary', params);
    renderSubjectsBody(subs);
  };

  document.getElementById('btnAddSubject').onclick = async () => {
    const nameEl = document.getElementById('subj_new_name');
    const subject_name = nameEl.value.trim();
    const streamEl = document.getElementById('subj_new_stream');
    const stream = showStreamField && streamEl ? (streamEl.value || null) : null;
    if (!subject_name) { setErrorMsg(msg, t('sa_subject_required')); return; }
    if (!(await showPasswordConfirm(t('sa_pwconfirm_subject')))) return;
    try {
      const result = await apiPost('/api/super/subject-dictionary', { subject_name, school_level: subjectsCurrentLevel, stream });
      setSuccessMsg(msg, result.message);
      await refreshBody();
    } catch (err) { setErrorMsg(msg, err.message); }
  };

  document.querySelectorAll('.subj-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      const nameCell = tr.querySelector('.subj-name');
      const current = nameCell.textContent;
      const next = prompt(t('sa_edit_subject_prompt'), current);
      if (next === null || !next.trim() || next.trim() === current) return;
      if (!(await showPasswordConfirm(t('sa_pwconfirm_subject')))) return;
      try {
        await apiPut(`/api/super/subject-dictionary/${id}`, { subject_name: next.trim() });
        await refreshBody();
      } catch (err) { setErrorMsg(msg, err.message); }
    });
  });
  document.querySelectorAll('.subj-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      if (!(await showConfirm(t('sa_confirm_delete_subject')))) return;
      if (!(await showPasswordConfirm(t('sa_pwconfirm_subject')))) return;
      try {
        await apiDelete(`/api/super/subject-dictionary/${id}`);
        await refreshBody();
      } catch (err) { setErrorMsg(msg, err.message); }
    });
  });
}

/* ==================================================================
   Student Roster — pick a school, upload a .csv/.xlsx roster (Name,
   Sex, Class, Section, Stream), see what's still pending assignment.
   The school's own Registrar finishes each row (fayda/phone + real
   student ID) via POST /api/registrar/pending-roster/:id/assign-id.
   ================================================================== */
let rosterCurrentSchool = null;
function rosterSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="upload"></i> ${t('sa_nav_roster')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}
async function loadAndRenderRoster() {
  try {
    const schools = await apiGet('/api/super/schools');
    renderRosterPanel(schools);
  } catch (err) {
    document.getElementById('content').innerHTML = errorPanel(err);
  }
}
function renderRosterPanel(schools) {
  const schoolOpts = schools.map(s => `<option value="${s.id}" ${String(s.id) === String(rosterCurrentSchool) ? 'selected' : ''}>${s.school_name} (${s.zone_name || '—'})</option>`).join('');
  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="upload"></i> ${t('sa_nav_roster')}</h3>
    <div class="form-grid">
      <div class="form-field">
        <label for="roster_school">${t('sa_f_school')}</label>
        <select id="roster_school"><option value="">${t('sa_pick_school')}</option>${schoolOpts}</select>
      </div>
    </div>
    <div id="rosterBody">
      ${rosterCurrentSchool ? '' : `<p class="hint">${t('sa_pick_school_first')}</p>`}
    </div>
  </div>`;

  const schoolEl = document.getElementById('roster_school');
  schoolEl.addEventListener('change', async () => {
    rosterCurrentSchool = schoolEl.value || null;
    if (!rosterCurrentSchool) {
      document.getElementById('rosterBody').innerHTML = `<p class="hint">${t('sa_pick_school_first')}</p>`;
      return;
    }
    await refreshRosterBody();
  });
  if (rosterCurrentSchool) schoolEl.dispatchEvent(new Event('change'));
}
async function refreshRosterBody() {
  try {
    const pending = await apiGet(`/api/super/schools/${rosterCurrentSchool}/roster`);
    renderRosterBody(pending);
  } catch (err) {
    document.getElementById('rosterBody').innerHTML = errorPanel(err);
  }
}
function renderRosterBody(pending) {
  const rows = pending.length ? pending.map(p => `
    <tr>
      <td>${[p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ')}</td>
      <td>${p.sex}</td><td>${p.class_level}</td><td>${p.section}</td><td>${p.stream || '—'}</td>
      <td><span class="badge ${p.status === 'assigned' ? 'open' : 'gold'}">${t('sa_roster_status_' + p.status)}</span>${p.assigned_student_id ? ` <span class="hint">${p.assigned_student_id}</span>` : ''}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="hint">${t('sa_roster_empty')}</td></tr>`;

  document.getElementById('rosterBody').innerHTML = `
    <div class="form-field">
      <label for="roster_file">${t('sa_f_roster_file')}</label>
      <input type="file" id="roster_file" accept=".csv,.xlsx">
      <p class="hint">${t('sa_roster_file_hint')}</p>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="btnUploadRoster">${t('sa_upload_roster')}</button>
    </div>
    <p class="hint" id="rosterFormMsg"></p>
    <div id="rosterUploadResult"></div>
    <div class="table-wrap"><table>
      <tr><th>${t('sa_th_name')}</th><th>${t('sa_th_sex')}</th><th>${t('sa_th_class')}</th><th>${t('sa_th_section')}</th><th>${t('sa_th_stream')}</th><th>${t('sa_th_status')}</th></tr>
      ${rows}
    </table></div>`;

  const msg = document.getElementById('rosterFormMsg');
  document.getElementById('btnUploadRoster').onclick = async () => {
    const fileEl = document.getElementById('roster_file');
    const file = fileEl.files[0];
    if (!file) { setErrorMsg(msg, t('sa_roster_file_required')); return; }
    if (!(await showPasswordConfirm(t('sa_pwconfirm_roster')))) return;
    try {
      const formData = new FormData();
      formData.append('roster', file);
      const result = await apiUpload(`/api/super/schools/${rosterCurrentSchool}/roster/upload`, formData);
      setSuccessMsg(msg, result.message);
      const resultEl = document.getElementById('rosterUploadResult');
      if (result.errors && result.errors.length) {
        resultEl.innerHTML = `<div class="alert-box error"><div class="icon"><i data-lucide="alert-triangle"></i></div><div class="body">
          ${t('sa_roster_skipped', { n: result.skipped })}
          <ul>${result.errors.map(e => `<li>${t('sa_roster_row_error', { row: e.row, error: e.error })}</li>`).join('')}</ul>
        </div></div>`;
      } else {
        resultEl.innerHTML = '';
      }
      fileEl.value = '';
      await refreshRosterBody();
    } catch (err) { setErrorMsg(msg, err.message); }
  };
}

/* ==================================================================
   Activity Log — read-only view of audit_log via /api/super/audit-log.
   ================================================================== */
function auditSkeletonHTML() {
  return `<div class="panel"><h3><i data-lucide="scroll-text"></i> ${t('sa_nav_audit')}</h3><p class="hint">${t('za_loading')}</p></div>`;
}
async function loadAndRenderAuditLog() {
  try {
    const entries = await apiGet('/api/super/audit-log', { limit: 100 });
    renderAuditLogPanel(entries);
  } catch (err) {
    document.getElementById('content').innerHTML = errorPanel(err);
  }
}
function renderAuditLogPanel(entries) {
  const rows = entries.length ? entries.map(a => `
    <tr>
      <td>${a.action}</td>
      <td>${a.actor_id}</td>
      <td>${a.target_type ? `${a.target_type}${a.target_id ? ' #' + a.target_id : ''}` : '—'}</td>
      <td>${a.details || '—'}</td>
      <td>${new Date(a.created_at).toLocaleString()}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="hint">${t('sa_audit_empty')}</td></tr>`;

  document.getElementById('content').innerHTML = `
  <div class="panel">
    <h3><i data-lucide="scroll-text"></i> ${t('sa_nav_audit')}</h3>
    <div class="table-wrap"><table>
      <tr><th>${t('sa_th_action')}</th><th>${t('sa_th_actor')}</th><th>${t('sa_th_target')}</th><th>${t('sa_th_details')}</th><th>${t('sa_th_when')}</th></tr>
      ${rows}
    </table></div>
  </div>`;
}

/* ---------------- Page router ----------------------------------------- */
function render() {
  if (!navHasPage(activePage)) activePage = 'sa_nav_dashboard';
  renderNav();
  renderTopChrome();
  const c = document.getElementById('content');
  if (activePage === 'sa_nav_dashboard') { c.innerHTML = dashboardSkeletonHTML(); loadAndRenderDashboard(); }
  else if (activePage === 'sa_nav_regions') { c.innerHTML = regionsSkeletonHTML(); loadAndRenderRegions(); }
  else if (activePage === 'sa_nav_zonal_admins') { c.innerHTML = zonalAdminsSkeletonHTML(); loadAndRenderZonalAdmins(); }
  else if (activePage === 'sa_nav_schools') { c.innerHTML = schoolsSkeletonHTML(); loadAndRenderSchools(); }
  else if (activePage === 'sa_nav_subjects') { c.innerHTML = subjectsSkeletonHTML(); loadAndRenderSubjects(); }
  else if (activePage === 'sa_nav_roster') { c.innerHTML = rosterSkeletonHTML(); loadAndRenderRoster(); }
  else if (activePage === 'sa_nav_audit') { c.innerHTML = auditSkeletonHTML(); loadAndRenderAuditLog(); }
  else c.innerHTML = genericPanel(activePage, 'file-text');
}

/* ---------------- Session bootstrap — GET /api/me ---------------------
   guard.js has already bounced us to /login.html if the auth_token
   cookie is missing/invalid; this confirms the account is specifically
   super_admins (not any other role landing on this portal by mistake). */
async function loadCurrentUser() {
  const me = await apiGet('/api/me');
  if (me.role !== 'super_admins') {
    handleUnauthorized();
    throw new Error('Not a super admin account');
  }
  CURRENT_USER = me;
  role = 'super';
}

function wireChrome() {
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (!(await showConfirm(t('za_logout_confirm')))) return;
    try { await apiPost('/api/logout'); } catch (err) { /* best-effort; redirect regardless */ }
    window.location.href = '/login.html';
  });
  document.getElementById('navOpenBtn').addEventListener('click', openMobileNav);
  document.getElementById('navCloseBtn').addEventListener('click', closeMobileNav);
  document.getElementById('navOverlay').addEventListener('click', closeMobileNav);

  const brandBadgeImg = document.getElementById('brandBadgeImg');
  if (brandBadgeImg) {
    brandBadgeImg.addEventListener('error', () => {
      brandBadgeImg.style.display = 'none';
      const fallbackId = brandBadgeImg.dataset.fallbackTarget;
      const fallbackEl = fallbackId ? document.getElementById(fallbackId) : brandBadgeImg.nextElementSibling;
      if (fallbackEl) fallbackEl.style.display = 'flex';
    });
  }
  document.querySelectorAll('.lang-switch-btn[data-lang]').forEach((btn) => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });
}

let lucideRaf = null;
function scheduleLucideRender() {
  if (lucideRaf) return;
  lucideRaf = requestAnimationFrame(() => { lucideRaf = null; if (window.lucide) window.lucide.createIcons(); });
}
new MutationObserver(scheduleLucideRender).observe(document.body, { childList: true, subtree: true });

async function boot() {
  try {
    await loadCurrentUser();
  } catch (err) {
    return;
  }
  wireChrome();
  render();
  scheduleLucideRender();
}

window.onSisLangChange = () => { if (CURRENT_USER) render(); };
document.addEventListener('DOMContentLoaded', boot);
