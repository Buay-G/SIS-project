// Live updates: loads /assets/js/live.js, which keeps a server-sent-events
// connection open so new payments/requests appear without a browser
// refresh. onLiveChange() calls made before live.js has loaded are queued.
(function () {
    if (window.onLiveChange) return;
    window.__liveQueue = [];
    window.onLiveChange = (fn) => window.__liveQueue.push(fn);
    const el = document.createElement('script');
    el.src = '/assets/js/live.js';
    document.head.appendChild(el);
})();

// Kindergarten classes are stored as class_level -3/-2/-1 (see server.js).
// Never print the raw number: map to KG1/KG2/KG3, pass anything else through.
const KG_LABELS = { "-3": "KG1", "-2": "KG2", "-1": "KG3" };
const isKgLevel = (g) => Object.prototype.hasOwnProperty.call(KG_LABELS, String(g));
const gradeDisp = (g) => (isKgLevel(g) ? KG_LABELS[String(g)] : g);

// ==========================================================
// FINANCE PORTAL — new finance_users role (see governance.js /
// userCan pattern from the Finance module design). One Finance
// account per school: Public schools collect registration fee
// only; Private schools collect registration fee + monthly
// tuition (Invoices/Overdue nav items + dashboard cards are
// hidden entirely for Public schools).
//
// *** ASSUMPTION FLAG ***
// The exact Finance API routes haven't been shared/confirmed yet
// (only the data model — fee_structures, fee_payments,
// fee_invoices, fee_reminders — and the payment-verification flow
// were documented). Every endpoint below is a best-guess built
// from that design, following the same /api/<role>/<resource>
// convention already used by every other portal in this codebase
// (e.g. /api/registrar/..., /api/academic-vp/...). If the real
// server.js routes differ, this file's endpoint paths/field names
// need to be updated to match — grep for "/api/finance/" below to
// find every call site in one pass.
// ==========================================================

const API_BASE = '';
let CURRENT_FIN_USER = null;
let SCHOOL_TYPE = 'Public'; // 'Public' | 'Private' — resolved from /api/me

// ---------- i18n ----------
// t(), applyTranslations(), window.setLang() and getCurrentLang() now
// come from the shared /assets/js/i18n.js (loaded in index.html before
// this file). The fin_* keys this page needs have been merged into
// SIS_TRANSLATIONS.en/am there — no local dictionary needed here
// anymore. See i18n.js's window.setLang for the localStorage key used
// ("sis_lang") and window.onSisLangChange for re-rendering dynamic
// (fetched) content after a language switch.

// ---------- API / toast helpers (same pattern as school-admin's script.js) ----------
async function apiFetch(url, options = {}) {
    const res = await fetch(url, { credentials: 'include', ...options });
    if (res.status === 403) {
        // The server blocks every fee route until the default password
        // is replaced — surface the forced screen instead of a generic error.
        res.clone().json().then(d => { if (d && d.must_change_password) showForcedPasswordChange(); }).catch(() => {});
    }
    return res;
}
function showToast(message, type = '') {
    const container = document.getElementById('fin-toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type ? 'toast-' + type : ''}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), Math.max(3500, String(message).length * 70));
}
async function handleJsonResponse(res, successMsg) {
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) { showToast(data.error || 'Something went wrong.', 'error'); return null; }
    if (successMsg) showToast(data.message || successMsg, 'success');
    return data;
}
function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(n) {
    if (n === null || n === undefined || n === '') return '—';
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// ---------- Dates: Ethiopian calendar first, Gregorian (GC) in brackets ----------
// Same Julian-Day-Number conversion as server.js's toEthiopianDate() and the
// other portals' script.js, so every portal agrees on the same day. Month
// names come from the shared eth_month_* i18n keys (EN/AM).
const ETH_MONTH_KEYS = ['meskerem', 'tikimt', 'hidar', 'tahsas', 'tir', 'yekatit', 'megabit', 'miazia', 'ginbot', 'sene', 'hamle', 'nehase', 'pagume'];
const JD_EPOCH_OFFSET_AMETE_MIHRET = 1723856;
function gregorianToJdn(year, month, day) {
    const a = Math.floor((14 - month) / 12);
    const y = year + 4800 - a;
    const m = month + 12 * a - 3;
    return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}
function toEthiopianDate(d) {
    const jdn = gregorianToJdn(d.getFullYear(), d.getMonth() + 1, d.getDate());
    const r = (jdn - JD_EPOCH_OFFSET_AMETE_MIHRET) % 1461;
    const n = (r % 365) + 365 * Math.floor(r / 1460);
    const year = 4 * Math.floor((jdn - JD_EPOCH_OFFSET_AMETE_MIHRET) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460);
    return { year, month: Math.floor(n / 30) + 1, day: (n % 30) + 1 };
}
function ethMonthName(m) { return t('eth_month_' + ETH_MONTH_KEYS[m - 1]); }
// 'YYYY-MM-DD' strings are read as local calendar dates (no timezone shift);
// anything else (ISO timestamps from the API) goes through Date.
function parseDateValue(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    const str = String(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(str);
    return isNaN(d) ? null : d;
}
function ecText(d) { const e = toEthiopianDate(d); return `${e.day} ${ethMonthName(e.month)} ${e.year} ${t('fin_ec_suffix')}`; }
function gcText(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
// Plain text — for hints, previews, confirm messages.
function fmtDateText(v) {
    const d = parseDateValue(v);
    if (!d) return v ? String(v) : '—';
    return `${ecText(d)} (${gcText(d)} GC)`;
}
// HTML — for table cells: Ethiopian date, GC underneath in brackets.
function fmtDate(v) {
    const d = parseDateValue(v);
    if (!d) return v ? escapeHtml(v) : '—';
    return `<span class="ec-date">${escapeHtml(ecText(d))}<span class="gc-date">(${escapeHtml(gcText(d))} GC)</span></span>`;
}
// A Gregorian month ("2026-07") shown as the Ethiopian dates it covers.
function fmtMonthText(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    if (!m) return '';
    const y = +m[1], mo = +m[2];
    const first = new Date(y, mo - 1, 1), last = new Date(y, mo, 0);
    const a = toEthiopianDate(first), b = toEthiopianDate(last);
    const left = `${a.day} ${ethMonthName(a.month)}${a.year !== b.year ? ' ' + a.year : ''}`;
    const gc = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    return `${left} – ${b.day} ${ethMonthName(b.month)} ${b.year} ${t('fin_ec_suffix')} (${gc} GC)`;
}
// An invoice's billing period: Ethiopian month of its due date, GC month in brackets.
function fmtInvoiceMonth(r) {
    const d = parseDateValue(r.due_date);
    if (!d) return escapeHtml(r.month || '—');
    const e = toEthiopianDate(d);
    return `${escapeHtml(ethMonthName(e.month))} ${e.year} ${escapeHtml(t('fin_ec_suffix'))}${r.month ? ` <span class="gc-date gc-inline">(${escapeHtml(r.month)} GC)</span>` : ''}`;
}
// Native date/month pickers can only be Gregorian, so each one gets a live
// Ethiopian read-out under it. The value sent to the server is unchanged.
function attachEcPreview(inputId, kind) {
    const input = document.getElementById(inputId);
    if (!input || input.dataset.ecBound) return;
    input.dataset.ecBound = '1';
    const hint = document.createElement('div');
    hint.className = 'form-hint ec-preview';
    input.insertAdjacentElement('afterend', hint);
    const update = () => {
        const v = input.value;
        hint.textContent = v ? t('fin_ec_preview', { date: kind === 'month' ? fmtMonthText(v) : fmtDateText(v) }) : '';
    };
    input.addEventListener('input', update);
    input.addEventListener('change', update);
    input._ecUpdate = update;
    update();
}
function refreshEcPreviews() {
    document.querySelectorAll('[data-ec-bound]').forEach(i => i._ecUpdate && i._ecUpdate());
}
function wireEcPreviews() {
    attachEcPreview('inv-month-filter', 'month');
    ['sch-from', 'sch-to', 'rep-from-input', 'rep-to-input'].forEach(id => attachEcPreview(id, 'date'));
}
function badgeClass(status) {
    const s = String(status || '').toLowerCase();
    if (['approved', 'paid'].includes(s)) return 'badge-approved';
    if (['waived', 'active', 'scholarship', 'sponsor', 'family'].includes(s)) return 'badge-waived';
    if (['pending'].includes(s)) return 'badge-pending';
    if (['rejected', 'overdue'].includes(s)) return 'badge-rejected';
    return 'badge-none';
}

// ---------- Modal (same shape as school-admin's showConfirmModal) ----------
function openModal(html, { wide = false, onDismiss = null } = {}) {
    closeModal();
    const root = document.getElementById('fin-modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'fin-active-modal';
    overlay.innerHTML = `<div class="modal-box"${wide ? ' style="max-width:720px"' : ''}>${html}</div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) { closeModal(); if (onDismiss) onDismiss(); } });
    root.appendChild(overlay);
}
function closeModal() {
    const existing = document.getElementById('fin-active-modal');
    if (existing) existing.remove();
}
function showConfirmModal(message, { danger = false, confirmLabel, cancelLabel } = {}) {
    return new Promise(resolve => {
        openModal(`
            <p>${escapeHtml(message)}</p>
            <div class="form-actions">
                <button class="btn btn-ghost" id="fin-modal-cancel-btn">${cancelLabel || t('fin_cancel')}</button>
                <button class="btn ${danger ? 'btn-danger' : 'btn-accent'}" id="fin-modal-confirm-btn">${confirmLabel || t('fin_confirm')}</button>
            </div>
        `);
        document.getElementById('fin-modal-cancel-btn').addEventListener('click', () => { closeModal(); resolve(false); });
        document.getElementById('fin-modal-confirm-btn').addEventListener('click', () => { closeModal(); resolve(true); });
    });
}
function showReasonModal(heading, label) {
    return new Promise(resolve => {
        openModal(`
            <h3>${escapeHtml(heading)}</h3>
            <div class="form-group">
                <label>${escapeHtml(label)}</label>
                <textarea id="fin-modal-reason-input"></textarea>
            </div>
            <div class="form-actions">
                <button class="btn btn-ghost" id="fin-modal-cancel-btn">${t('fin_cancel')}</button>
                <button class="btn btn-danger" id="fin-modal-confirm-btn">${t('fin_confirm')}</button>
            </div>
        `);
        document.getElementById('fin-modal-cancel-btn').addEventListener('click', () => { closeModal(); resolve(null); });
        document.getElementById('fin-modal-confirm-btn').addEventListener('click', () => {
            const val = document.getElementById('fin-modal-reason-input').value.trim();
            closeModal();
            resolve(val || '');
        });
    });
}

// ---------- Password step-up for fee changes ----------
// Saving fees or publishing invoices needs the officer's own password. The
// modal checks it against /api/finance/verify-password (so a typo shows right
// here and the modal stays open), then hands the password back so the save
// request can carry it — the server re-checks it on every fee route, so this
// prompt can't be bypassed by calling the route directly.
function askFinancePassword({ title, description, confirmLabel } = {}) {
    return new Promise(resolve => {
        openModal(`
            <div class="pw-modal">
                <div class="pw-modal-icon"><svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg></div>
                <h3>${escapeHtml(title || t('fin_pw_title'))}</h3>
                <p class="pw-modal-desc">${escapeHtml(description || t('fin_pw_desc_save'))}</p>
                <div class="form-group">
                    <label for="fin-pw-input">${escapeHtml(t('fin_pw_label'))}</label>
                    <div class="fee-input pw-input">
                        <input type="password" id="fin-pw-input" autocomplete="current-password" />
                        <button type="button" class="pw-toggle" id="fin-pw-toggle">${escapeHtml(t('fin_pw_show'))}</button>
                    </div>
                    <p class="pw-error" id="fin-pw-error" role="alert"></p>
                </div>
                <div class="form-actions">
                    <button class="btn btn-ghost" id="fin-pw-cancel">${escapeHtml(t('fin_cancel'))}</button>
                    <button class="btn btn-accent" id="fin-pw-confirm">${escapeHtml(confirmLabel || t('fin_pw_confirm_save'))}</button>
                </div>
            </div>`, { onDismiss: () => resolve(null) });
        const input = document.getElementById('fin-pw-input');
        const err = document.getElementById('fin-pw-error');
        const confirmBtn = document.getElementById('fin-pw-confirm');
        input.focus();
        document.getElementById('fin-pw-cancel').addEventListener('click', () => { closeModal(); resolve(null); });
        document.getElementById('fin-pw-toggle').addEventListener('click', e => {
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            e.currentTarget.textContent = t(show ? 'fin_pw_hide' : 'fin_pw_show');
        });
        const submit = async () => {
            const pw = input.value;
            err.textContent = '';
            if (!pw) { err.textContent = t('fin_pw_required'); input.focus(); return; }
            confirmBtn.disabled = true;
            try {
                const res = await apiFetch(`${API_BASE}/api/finance/verify-password`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }),
                });
                if (res.ok) { closeModal(); resolve(pw); return; }
                let d = {}; try { d = await res.json(); } catch (e) {}
                err.textContent = res.status === 401 ? t('fin_pw_incorrect') : (d.error || t('fin_load_error'));
                input.select();
            } catch (e) {
                err.textContent = t('fin_load_error');
            } finally {
                confirmBtn.disabled = false;
            }
        };
        confirmBtn.addEventListener('click', submit);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    });
}
// Ask for the password, then send the change with it. Resolves to the parsed
// response, or null if cancelled / rejected.
async function sendWithPassword(url, method, body, { successMsg, title, description, confirmLabel } = {}) {
    const password = await askFinancePassword({ title, description, confirmLabel });
    if (password === null) return null;
    const res = await apiFetch(url, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, password }),
    });
    return handleJsonResponse(res, successMsg);
}

// ---------- Auth / init ----------
async function checkAuthAndInit() {
    try {
        const res = await apiFetch(`${API_BASE}/api/me`);
        if (!res.ok) { window.location.href = '/login.html'; return; }
        const data = await res.json();
        // ASSUMPTION: finance accounts report role 'finance_users',
        // matching the existing table-name-as-role convention
        // (registrar_users, school_admins) already used elsewhere.
        if (data.role !== 'finance_users') { window.location.href = '/login.html'; return; }

        CURRENT_FIN_USER = data;
        // A new Finance account starts on the default password and must
        // set its own before anything else loads.
        if (data.must_change_password) { showForcedPasswordChange(); return; }
        // /api/me reports governance_model ('public' | 'private'), not school_type.
        SCHOOL_TYPE = (data.governance_model === 'private' || data.school_type === 'Private') ? 'Private' : 'Public';

        const schoolDisplayName = (data.school_name || '').toUpperCase();
        document.getElementById('fin-school-name').textContent = schoolDisplayName || '—';
        document.getElementById('topbar-school-name').textContent = schoolDisplayName || '—';
        document.getElementById('topbar-moe-code').textContent = data.moe_school_code ? t('fin_topbar_moe', { code: data.moe_school_code }) : t('fin_topbar_moe_unknown');
        const typeChip = document.getElementById('topbar-school-type-chip');
        if (typeChip) { typeChip.textContent = SCHOOL_TYPE; typeChip.style.display = ''; }

        // /api/me reports the officer's name as admin_full_name. The ID stays
        // on the Profile page only — the sidebar and top bar show the name.
        const displayName = data.admin_full_name || data.full_name || data.user_id || 'Finance';
        document.getElementById('fin-nav-account-name').textContent = displayName;
        setSidebarLogo(data.display_logo_url || data.logo_url, schoolDisplayName);
        document.getElementById('fin-profile-id').textContent = data.user_id || '—';
        document.getElementById('fin-profile-name').textContent = displayName;
        document.getElementById('fin-profile-title').textContent = t('fin_title_finance_officer');
        document.getElementById('fin-profile-header-name').textContent = displayName;

        const initials = displayName.split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'FN';
        document.getElementById('fin-avatar-initials-text').textContent = initials;
        document.getElementById('fin-profile-avatar-text').textContent = initials;

        document.querySelectorAll('.fin-private-only').forEach(el => {
            el.style.display = SCHOOL_TYPE === 'Private' ? '' : 'none';
        });

        applyTranslations();
        // Table rows etc. are built with t() at fetch time rather than
        // data-i18n attributes, so a language switch needs to re-run
        // whichever page is currently open, not just re-apply static
        // text. i18n.js's setLang() calls this automatically.
        window.onSisLangChange = () => {
            const active = document.querySelector('.nav-link[data-page].active');
            const loader = active && PAGE_LOADERS[active.dataset.page];
            if (loader) loader();
            refreshEcPreviews();
        };
        wireNav();
        wireSidebarToggle();
        wireLangSwitch();
        wireLogout();
        wirePageActions();
        wireFinanceExtras();
        wireEcPreviews();
        wireSubscription();
        initSubscriptionNav();
        navigateToPage('dashboard');
        refreshDocFeeBadge();
        setInterval(refreshDocFeeBadge, 60000);
    } catch (e) {
        console.error('[finance] init failed', e);
        showToast(t('fin_err_account_load'), 'error');
    }
}

// The school's own logo replaces the "FIN" badge at the top of the sidebar
// (display_logo_url is school logo first, zone logo as the fallback). The
// image is preloaded so a missing/broken file just leaves the badge as is.
function setSidebarLogo(url, schoolName) {
    const badge = document.getElementById('fin-logo-badge');
    if (!badge || !url) return;
    const img = new Image();
    img.alt = schoolName || '';
    img.onload = () => { badge.textContent = ''; badge.appendChild(img); badge.classList.add('has-logo'); };
    img.src = `${API_BASE}${url}`;
}

// ---------- Navigation ----------
function wireNav() {
    document.querySelectorAll('.nav-link[data-page]').forEach(link => {
        link.addEventListener('click', e => {
            e.preventDefault();
            navigateToPage(link.dataset.page);
        });
    });
}
const PAGE_LOADERS = {
    dashboard: loadDashboard,
    'verify-payments': loadPendingPayments,
    'document-fees': loadDocFeeApprovals,
    'fee-setup': loadFeeSetup,
    subscription: loadSubscription,
    students: loadStudentsDues,
    scholarships: loadScholarships,
    invoices: loadInvoices,
    'overdue-reminders': loadOverdue,
    reports: () => {}, // Reports loads on-demand via its own "Load Report" button
    profile: () => {},
};
function navigateToPage(page) {
    document.querySelectorAll('.page-content').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`page-${page}`);
    if (!target) return;
    target.classList.add('active');
    document.querySelectorAll('.nav-link[data-page]').forEach(l => l.classList.toggle('active', l.dataset.page === page));
    const activeLink = document.querySelector(`.nav-link[data-page="${page}"]`);
    document.getElementById('fin-page-title').textContent = activeLink ? activeLink.querySelector('span:last-child').textContent : page;
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-backdrop').classList.remove('active');
    const loader = PAGE_LOADERS[page];
    if (loader) loader();
}
function wireSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        sidebar.classList.add('open');
        backdrop.classList.add('active');
    });
    backdrop.addEventListener('click', () => {
        sidebar.classList.remove('open');
        backdrop.classList.remove('active');
    });
}
function wireLangSwitch() {
    document.querySelectorAll('.lang-switch-btn').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));
}
function wireLogout() {
    document.getElementById('fin-logout-btn').addEventListener('click', async e => {
        e.preventDefault();
        const confirmed = await showConfirmModal(t('fin_logout_confirm_msg'), { danger: true, confirmLabel: t('fin_logout') });
        if (!confirmed) return;
        await apiFetch(`${API_BASE}/api/logout`, { method: 'POST' }).catch(() => {});
        window.location.href = '/login.html';
    });
}

// ---------- DASHBOARD ----------
async function loadDashboard() {
    const res = await apiFetch(`${API_BASE}/api/finance/dashboard`);
    if (!res.ok) { showToast(t('fin_load_error'), 'error'); return; }
    const data = await res.json();
    document.getElementById('fin-stat-pending').textContent = data.pending_count ?? '0';
    document.getElementById('fin-stat-verified-today').textContent = data.verified_today_count ?? '0';
    document.getElementById('fin-stat-registration-collected').textContent = fmtMoney(data.registration_collected_term);
    if (SCHOOL_TYPE === 'Private') {
        document.getElementById('fin-stat-tuition-collected').textContent = fmtMoney(data.tuition_collected_month);
        document.getElementById('fin-stat-overdue').textContent = data.overdue_count ?? '0';
    }
    const pendingBadge = document.getElementById('fin-nav-pending-count');
    if (data.pending_count > 0) { pendingBadge.textContent = data.pending_count; pendingBadge.style.display = ''; }
    else pendingBadge.style.display = 'none';
    const overdueBadge = document.getElementById('fin-nav-overdue-count');
    if (SCHOOL_TYPE === 'Private' && data.overdue_count > 0) { overdueBadge.textContent = data.overdue_count; overdueBadge.style.display = ''; }
    else if (overdueBadge) overdueBadge.style.display = 'none';

    const tbody = document.getElementById('fin-dashboard-recent-tbody');
    const rows = data.recent || [];
    tbody.innerHTML = rows.length ? rows.map(r => `
        <tr>
            <td>${escapeHtml(r.student_name)}</td>
            <td>${escapeHtml(r.fee_type)}</td>
            <td>${fmtMoney(r.amount)}</td>
            <td>${escapeHtml(r.method)}</td>
            <td><span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
        </tr>`).join('') : `<tr><td colspan="5">${t('fin_no_data')}</td></tr>`;

    document.getElementById('fin-dashboard-view-all-btn').onclick = () => navigateToPage('verify-payments');
}

// ---------- VERIFY PAYMENTS ----------
async function loadPendingPayments() {
    const status = document.getElementById('vp-status-filter').value;
    const search = document.getElementById('vp-search-input').value.trim();
    const tbody = document.getElementById('fin-payments-tbody');
    tbody.innerHTML = `<tr><td colspan="8">${t('fin_loading')}</td></tr>`;
    const params = new URLSearchParams({ status });
    if (search) params.set('search', search);
    const res = await apiFetch(`${API_BASE}/api/finance/payments?${params}`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="8">${t('fin_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    tbody.innerHTML = rows.length ? rows.map(r => `
        <tr>
            <td>${studentWhoCell(r)}</td>
            <td>${escapeHtml(r.class_level ? gradeDisp(r.class_level) : '—')}${r.stream ? `<div class="form-hint">${escapeHtml(r.stream)}</div>` : ''}</td>
            <td>${paymentTypeCell(r)}</td>
            <td>${fmtMoney(r.amount)}</td>
            <td>${escapeHtml(r.method)}</td>
            <td>${r.receipt_url ? `<button class="btn btn-ghost btn-sm" data-receipt="${escapeHtml(r.receipt_url)}">${t('fin_view_receipt')}</button>` : escapeHtml(r.reference || '—')}</td>
            <td>${fmtDate(r.submitted_at)}</td>
            <td>
                ${r.status === 'pending' ? `
                    <button class="btn btn-success btn-sm" data-approve="${r.payment_id}">${t('fin_approve')}</button>
                    <button class="btn btn-danger btn-sm" data-reject="${r.payment_id}">${t('fin_reject')}</button>
                ` : `<span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status)}</span>`}
            </td>
        </tr>`).join('') : `<tr><td colspan="8">${t('fin_no_data')}</td></tr>`;

    tbody.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => approvePayment(b.dataset.approve)));
    tbody.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', () => rejectPayment(b.dataset.reject)));
    tbody.querySelectorAll('[data-receipt]').forEach(b => b.addEventListener('click', () => window.open(`${API_BASE}${b.dataset.receipt}`, '_blank')));
}
// A registration payment that also carries the student's subscription fee
// shows the split, so Finance can match the total against the receipt.
function paymentTypeCell(r) {
    const sub = Number(r.subscription_amount || 0);
    if (!(sub > 0)) return escapeHtml(r.fee_type);
    const reg = Number(r.amount) - sub;
    const cycle = r.subscription_cycle === 'yearly' ? 'yearly' : 'monthly';
    return `${escapeHtml(r.fee_type)} + Subscription`
        + `<div class="fee-split">Registration ${fmtMoney(reg)} + Subscription ${fmtMoney(sub)} (${cycle})</div>`;
}
async function approvePayment(id) {
    const confirmed = await showConfirmModal(t('fin_approve_confirm_msg'));
    if (!confirmed) return;
    const res = await apiFetch(`${API_BASE}/api/finance/payments/${id}/approve`, { method: 'POST' });
    const data = await handleJsonResponse(res, 'Payment approved.');
    if (data) { loadPendingPayments(); loadDashboard(); }
}
async function rejectPayment(id) {
    const reason = await showReasonModal(t('fin_reject_reason_heading'), t('fin_reject_reason_label'));
    if (reason === null) return;
    if (!reason) { showToast(t('fin_err_reason_required'), 'error'); return; }
    const res = await apiFetch(`${API_BASE}/api/finance/payments/${id}/reject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
    });
    const data = await handleJsonResponse(res, 'Payment rejected.');
    if (data) { loadPendingPayments(); loadDashboard(); }
}

// ---------- FEE SETUP ----------
async function loadFeeSetup() {
    const res = await apiFetch(`${API_BASE}/api/finance/fee-structure`);
    if (!res.ok) { showToast(t('fin_load_error'), 'error'); return; }
    const data = await res.json();
    const chip = document.getElementById('fee-year-chip');
    if (data.academic_year) { chip.textContent = t('fin_fee_year_chip', { year: data.academic_year }); chip.style.display = ''; }
    renderSubscriptionFeeCard(data.subscription);
    loadDocumentFees();
    document.getElementById('fee-registration-amount').value = data.registration_amount ?? '';
    document.getElementById('fee-registration-current-hint').textContent = data.registration_amount != null
        ? t('fin_fee_current', { amount: fmtMoney(data.registration_amount) }) : '';
    if (SCHOOL_TYPE === 'Private') {
        document.getElementById('fee-tuition-amount').value = data.tuition_amount ?? '';
        document.getElementById('fee-tuition-due-day').value = data.tuition_due_day ?? '';
        document.getElementById('fee-tuition-current-hint').textContent = data.tuition_due_day != null
            ? t('fin_fee_due_on', { day: data.tuition_due_day }) + (Number(data.tuition_amount) > 0 ? t('fin_fee_due_default', { amount: fmtMoney(data.tuition_amount) }) : '') : '';
        loadClassRates();
    }
}
// Read-only: the Super Admin sets the subscription fee and how it is billed.
function renderSubscriptionFeeCard(sub) {
    const card = document.getElementById('fee-subscription-card');
    if (!card) return;
    const on = !!(sub && sub.enabled);
    card.style.display = on ? '' : 'none';
    if (!on) return;
    const yearly = sub.billing_cycle === 'yearly';
    document.getElementById('fee-sub-amount').textContent = `ETB ${fmtMoney(sub.student_fee)}`;
    document.getElementById('fee-sub-cycle').textContent = yearly ? 'Yearly' : 'Monthly';
    document.getElementById('fee-sub-hint').textContent = yearly
        ? 'Added to each registration. Covers the rest of the year.'
        : 'Added to each registration for the first month. Later months are marked under Subscription.';
}
function wirePageActions() {
    document.getElementById('vp-refresh-btn').addEventListener('click', loadPendingPayments);
    document.getElementById('vp-status-filter').addEventListener('change', loadPendingPayments);
    document.getElementById('vp-search-input').addEventListener('keydown', e => { if (e.key === 'Enter') loadPendingPayments(); });

    document.getElementById('fee-registration-save-btn').addEventListener('click', async () => {
        const amount = document.getElementById('fee-registration-amount').value;
        if (!amount) return showToast(t('fin_err_enter_amount'), 'error');
        const data = await sendWithPassword(`${API_BASE}/api/finance/fee-structure/registration`, 'PUT', { amount }, {
            successMsg: t('fin_fee_registration_saved'), description: t('fin_pw_desc_save'), confirmLabel: t('fin_pw_confirm_save'),
        });
        if (data) loadFeeSetup();
    });
    const tuitionBtn = document.getElementById('fee-tuition-save-btn');
    if (tuitionBtn) tuitionBtn.addEventListener('click', async () => {
        const amount = document.getElementById('fee-tuition-amount').value || 0;
        const due_day = document.getElementById('fee-tuition-due-day').value;
        if (!due_day) return showToast(t('fin_fee_err_due_day'), 'error');
        const data = await sendWithPassword(`${API_BASE}/api/finance/fee-structure/tuition`, 'PUT', { amount, due_day }, {
            successMsg: t('fin_fee_tuition_saved'), description: t('fin_pw_desc_save'), confirmLabel: t('fin_pw_confirm_save'),
        });
        if (data) loadFeeSetup();
    });

    document.getElementById('inv-refresh-btn').addEventListener('click', loadInvoices);
    document.getElementById('inv-month-filter').addEventListener('change', loadInvoices);
    document.getElementById('inv-status-filter').addEventListener('change', loadInvoices);
    document.getElementById('inv-generate-btn').addEventListener('click', async () => {
        const month = document.getElementById('inv-month-filter').value;
        const msg = month ? t('fin_invoices_generate_msg_month', { month: fmtMonthText(month) }) : t('fin_invoices_generate_msg_now');
        const data = await sendWithPassword(`${API_BASE}/api/finance/invoices/generate`, 'POST', month ? { month } : {}, {
            successMsg: 'Invoices generated.', title: t('fin_generate_invoices_btn'), description: `${msg}\n\n${t('fin_pw_desc_publish')}`, confirmLabel: t('fin_pw_confirm_publish'),
        });
        if (data) { loadInvoices(); loadDashboard(); }
    });

    document.getElementById('overdue-send-all-btn').addEventListener('click', async () => {
        const confirmed = await showConfirmModal('Send a reminder to every overdue account?');
        if (!confirmed) return;
        const res = await apiFetch(`${API_BASE}/api/finance/reminders/send`, { method: 'POST' });
        const data = await handleJsonResponse(res, 'Reminders sent.');
        if (data) loadOverdue();
    });

    document.getElementById('rep-load-btn').addEventListener('click', loadReports);

    document.getElementById('pw-save-btn').addEventListener('click', async () => {
        const current_password = document.getElementById('pw-current-input').value;
        const new_password = document.getElementById('pw-new-input').value;
        const confirm_password = document.getElementById('pw-confirm-input').value;
        if (!current_password || !new_password) return showToast(t('fin_err_fill_password_fields'), 'error');
        if (new_password !== confirm_password) return showToast(t('fin_err_passwords_dont_match'), 'error');
        if (!/^\d{6}$/.test(new_password)) return showToast(t('fin_pin_err_len'), 'error');
        const res = await apiFetch(`${API_BASE}/api/finance/change-password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current_password, new_password }),
        });
        const data = await handleJsonResponse(res, t('fin_password_changed'));
        if (data) { document.getElementById('pw-current-input').value = ''; document.getElementById('pw-new-input').value = ''; document.getElementById('pw-confirm-input').value = ''; }
    });
}

// ---------- INVOICES (private schools) ----------
async function loadInvoices() {
    if (SCHOOL_TYPE !== 'Private') return;
    const tbody = document.getElementById('fin-invoices-tbody');
    tbody.innerHTML = `<tr><td colspan="7">${t('fin_loading')}</td></tr>`;
    const params = new URLSearchParams();
    const month = document.getElementById('inv-month-filter').value;
    const status = document.getElementById('inv-status-filter').value;
    if (month) params.set('month', month);
    if (status) params.set('status', status);
    const res = await apiFetch(`${API_BASE}/api/finance/invoices?${params}`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="7">${t('fin_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    tbody.innerHTML = rows.length ? rows.map(r => `
        <tr>
            <td>${escapeHtml(r.student_name)}</td>
            <td>${escapeHtml(r.class_level ? gradeDisp(r.class_level) : '—')}</td>
            <td>${fmtInvoiceMonth(r)}${r.semester ? ` <span class="form-hint">${escapeHtml(r.semester)}</span>` : ''}</td>
            <td>${fmtMoney(r.amount)}${r.original_amount ? ` <span class="form-hint">(fee ${fmtMoney(r.original_amount)})</span>` : ''}</td>
            <td>${fmtDate(r.due_date)}</td>
            <td><span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
            <td>${['pending', 'overdue'].includes(r.status) ? `<button class="btn btn-success btn-sm" data-markpaid="${r.invoice_id}">${t('fin_mark_paid')}</button>` : '—'}</td>
        </tr>`).join('') : `<tr><td colspan="7">${t('fin_no_data')}</td></tr>`;
    tbody.querySelectorAll('[data-markpaid]').forEach(b => b.addEventListener('click', () => {
        collectInvoicePayment(b.dataset.markpaid, () => { loadInvoices(); loadDashboard(); });
    }));
}

// ---------- OVERDUE & REMINDERS (private schools) ----------
async function loadOverdue() {
    if (SCHOOL_TYPE !== 'Private') return;
    const tbody = document.getElementById('fin-overdue-tbody');
    tbody.innerHTML = `<tr><td colspan="7">${t('fin_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/finance/overdue`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="7">${t('fin_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    tbody.innerHTML = rows.length ? rows.map(r => `
        <tr>
            <td>${escapeHtml(r.student_name)}</td>
            <td>${escapeHtml(r.class_level ? gradeDisp(r.class_level) : '—')}</td>
            <td>${escapeHtml(r.guardian_name || '—')}${r.guardian_phone ? `<br><span class="form-hint">${escapeHtml(r.guardian_phone)}</span>` : ''}</td>
            <td>${fmtMoney(r.amount_due)}</td>
            <td>${r.days_overdue ?? '—'}</td>
            <td>${r.last_reminder_at ? fmtDate(r.last_reminder_at) : '—'}</td>
            <td><button class="btn btn-ghost btn-sm" data-remind="${r.invoice_id}">${t('fin_send_reminder_btn')}</button></td>
        </tr>`).join('') : `<tr><td colspan="7">${t('fin_no_data')}</td></tr>`;
    tbody.querySelectorAll('[data-remind]').forEach(b => b.addEventListener('click', async () => {
        const res2 = await apiFetch(`${API_BASE}/api/finance/reminders/send`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoice_id: b.dataset.remind }),
        });
        const data = await handleJsonResponse(res2, 'Reminder sent.');
        if (data) loadOverdue();
    }));
}

// ---------- REPORTS ----------
async function loadReports() {
    const from = document.getElementById('rep-from-input').value;
    const to = document.getElementById('rep-to-input').value;
    if (!from || !to) return showToast(t('fin_err_pick_dates'), 'error');
    const tbody = document.getElementById('fin-report-tbody');
    tbody.innerHTML = `<tr><td colspan="5">${t('fin_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/finance/reports?${new URLSearchParams({ from, to })}`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${t('fin_load_error')}</td></tr>`; return; }
    const data = await res.json();
    document.getElementById('fin-report-total-collected').textContent = fmtMoney(data.total_collected);
    document.getElementById('fin-report-total-pending').textContent = fmtMoney(data.total_pending);
    document.getElementById('fin-report-total-rejected').textContent = fmtMoney(data.total_rejected);
    const rows = data.rows || [];
    tbody.innerHTML = rows.length ? rows.map(r => `
        <tr>
            <td>${fmtDate(r.date)}</td>
            <td>${studentWhoCell(r)}</td>
            <td>${escapeHtml(r.fee_type)}${r.method ? `<div class="form-hint">${escapeHtml(r.method)}${r.reference ? ' · ' + escapeHtml(r.reference) : ''}</div>` : ''}</td>
            <td>${fmtMoney(r.amount)}</td>
            <td><span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
        </tr>`).join('') : `<tr><td colspan="5">${t('fin_no_data')}</td></tr>`;
    loadDocumentCollections(from, to);
}

// Document fees the Registrar reported (shown under the collection report,
// same date range). Finance confirms each one once the money is in hand.
// Student cell used everywhere Finance looks at a payment: full name, ID,
// class and who recorded the money (the registrar's name), so nobody has to
// guess which student or which staff member a payment belongs to.
function studentWhoCell(r) {
    const cls = r.class_level ? `${isKgLevel(r.class_level) ? gradeDisp(r.class_level) : t('fin_col_class') + ' ' + r.class_level}${r.stream ? ' · ' + r.stream : ''}` : '';
    const by = r.submitted_by_name || r.collected_by_name;
    return `<strong>${escapeHtml(r.student_name || r.student_id)}</strong>`
        + `<div class="form-hint">${escapeHtml(r.student_id)}${cls ? ' · ' + escapeHtml(cls) : ''}</div>`
        + (by ? `<div class="form-hint">${escapeHtml(t('fin_recorded_by', { name: by }))}</div>` : '');
}
function docTypeLabel(k) { const key = `fin_docfee_type_${k}`; const v = t(key); return v === key ? k : v; }
function docPurposeLabel(k) { const key = `fin_docfee_purpose_${k}`; const v = t(key); return v === key ? k : v; }
async function loadDocumentCollections(from, to) {
    const tbody = document.getElementById('fin-doc-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7">${t('fin_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/finance/document-collections?${new URLSearchParams({ from, to, status: 'all' })}`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="7">${t('fin_load_error')}</td></tr>`; return; }
    const data = await res.json();
    document.getElementById('fin-doc-total-reported').textContent = fmtMoney(data.total_pending);
    document.getElementById('fin-doc-total-received').textContent = fmtMoney(data.total_approved);
    const rows = data.rows || [];
    tbody.innerHTML = rows.length ? rows.map(r => `
        <tr>
            <td>${fmtDate(r.collected_at)}</td>
            <td>${studentWhoCell(r)}</td>
            <td>${escapeHtml(docTypeLabel(r.doc_type))}</td>
            <td>${escapeHtml(docPurposeLabel(r.purpose))}</td>
            <td>${escapeHtml(r.receipt_ref || '—')}</td>
            <td>${fmtMoney(r.amount)}</td>
            <td><span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
        </tr>`).join('') : `<tr><td colspan="7">${t('fin_no_data')}</td></tr>`;
}

// ---------- DOCUMENT FEES: approve what the Registrar collected ----------
// Same job as Verify Payments, for the money the Registrar takes when issuing
// documents. The menu badge counts what is still waiting.
function setDocFeeBadge(n) {
    const badge = document.getElementById('fin-nav-doc-count');
    if (!badge) return;
    if (n > 0) { badge.textContent = n; badge.style.display = ''; }
    else badge.style.display = 'none';
}
async function refreshDocFeeBadge() {
    try {
        const res = await apiFetch(`${API_BASE}/api/finance/document-collections?status=pending`);
        if (!res.ok) return;
        const data = await res.json();
        setDocFeeBadge(data.pending_count || 0);
    } catch (e) { /* badge is best-effort */ }
}
async function loadDocFeeApprovals() {
    const tbody = document.getElementById('fin-docfee-tbody');
    tbody.innerHTML = `<tr><td colspan="7">${t('fin_loading')}</td></tr>`;
    const params = new URLSearchParams({ status: document.getElementById('docfee-status-filter').value });
    const q = document.getElementById('docfee-search-input').value.trim();
    if (q) params.set('q', q);
    const res = await apiFetch(`${API_BASE}/api/finance/document-collections?${params}`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="7">${t('fin_load_error')}</td></tr>`; return; }
    const data = await res.json();
    document.getElementById('fin-docfee-pending-total').textContent = `ETB ${fmtMoney(data.pending_total)}`;
    setDocFeeBadge(data.pending_count || 0);
    const rows = data.rows || [];
    tbody.innerHTML = rows.length ? rows.map(r => `
        <tr>
            <td>${studentWhoCell(r)}</td>
            <td>${escapeHtml(docTypeLabel(r.doc_type))}</td>
            <td>${escapeHtml(docPurposeLabel(r.purpose))}</td>
            <td>${escapeHtml(r.receipt_ref || '—')}</td>
            <td>${fmtMoney(r.amount)}</td>
            <td>${fmtDate(r.collected_at)}</td>
            <td>${r.status === 'pending' ? `
                    <button class="btn btn-success btn-sm" data-docfee-approve="${r.id}">${t('fin_approve')}</button>
                    <button class="btn btn-danger btn-sm" data-docfee-reject="${r.id}">${t('fin_reject')}</button>
                ` : `<span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status)}</span>${r.status === 'rejected' && r.reject_reason ? `<div class="form-hint">${escapeHtml(r.reject_reason)}</div>` : ''}`}
            </td>
        </tr>`).join('') : `<tr><td colspan="7">${t('fin_no_data')}</td></tr>`;
    tbody.querySelectorAll('[data-docfee-approve]').forEach(b => b.addEventListener('click', () => approveDocFee(b.dataset.docfeeApprove)));
    tbody.querySelectorAll('[data-docfee-reject]').forEach(b => b.addEventListener('click', () => rejectDocFee(b.dataset.docfeeReject)));
}
async function approveDocFee(id) {
    const confirmed = await showConfirmModal(t('fin_docfee_approve_confirm'));
    if (!confirmed) return;
    const res = await apiFetch(`${API_BASE}/api/finance/document-collections/${id}/approve`, { method: 'POST' });
    const data = await handleJsonResponse(res, t('fin_docfee_approved_msg'));
    if (data) loadDocFeeApprovals();
}
async function rejectDocFee(id) {
    const reason = await showReasonModal(t('fin_docfee_reject_title'), t('fin_docfee_reject_label'));
    if (reason === null) return;
    if (!reason) { showToast(t('fin_err_reason_required'), 'error'); return; }
    const res = await apiFetch(`${API_BASE}/api/finance/document-collections/${id}/reject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
    });
    const data = await handleJsonResponse(res, t('fin_docfee_rejected_msg'));
    if (data) loadDocFeeApprovals();
}

// ==========================================================
// FORCED PASSWORD CHANGE
// A new Finance account starts on the default password. The server
// rejects every fee route until it is replaced, and this screen
// can't be dismissed (no click-outside close, no other page loads).
// ==========================================================
function showForcedPasswordChange() {
    if (document.getElementById('fin-force-pw')) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay force-pw-overlay';
    overlay.id = 'fin-force-pw';
    overlay.style.zIndex = '400';
    overlay.innerHTML = `
        <div class="modal-box force-pw-box" role="dialog" aria-modal="true" aria-labelledby="force-pw-title">
            <h3 id="force-pw-title">${t('fin_force_title')}</h3>
            <p class="form-hint" style="margin-bottom:14px">${t('fin_force_hint')}</p>
            <div class="form-group"><label for="force-pw-current">${t('fin_force_current')}</label><input type="password" id="force-pw-current" autocomplete="current-password" /></div>
            <div class="form-group"><label for="force-pw-new">${t('fin_force_new')}</label><input type="password" id="force-pw-new" class="pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="new-password" /></div>
            <div class="form-group"><label for="force-pw-confirm">${t('fin_force_confirm')}</label><input type="password" id="force-pw-confirm" class="pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="new-password" /></div>
            <div class="form-actions">
                <button class="btn btn-ghost" id="force-pw-logout">${t('fin_logout')}</button>
                <button class="btn btn-accent" id="force-pw-save">${t('fin_force_save')}</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    document.getElementById('force-pw-logout').addEventListener('click', async () => {
        await fetch(`${API_BASE}/api/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
        window.location.href = '/login.html';
    });
    // Digits only, max 6 - same rule the server enforces (validateNewPin).
    ['force-pw-new', 'force-pw-confirm'].forEach(id => {
        const input = document.getElementById(id);
        input.addEventListener('input', () => {
            const clean = input.value.replace(/\D/g, '').slice(0, 6);
            if (clean !== input.value) input.value = clean;
        });
    });
    const saveBtn = document.getElementById('force-pw-save');
    const submitForcedPin = async () => {
        const current_password = document.getElementById('force-pw-current').value;
        const new_password = document.getElementById('force-pw-new').value;
        const confirm_password = document.getElementById('force-pw-confirm').value;
        if (!current_password || !new_password) return showToast(t('fin_pin_err_fields'), 'error');
        if (!/^\d{6}$/.test(new_password)) return showToast(t('fin_pin_err_len'), 'error');
        if (new_password !== confirm_password) return showToast(t('fin_pin_err_match'), 'error');
        saveBtn.disabled = true;
        try {
            const res = await fetch(`${API_BASE}/api/finance/change-password`, {
                method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ current_password, new_password }),
            });
            const data = await handleJsonResponse(res, t('fin_pin_updated'));
            if (data) window.location.reload();
        } finally {
            saveBtn.disabled = false;
        }
    };
    saveBtn.addEventListener('click', submitForcedPin);
    overlay.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); submitForcedPin(); }
    }));
    document.getElementById('force-pw-current').focus();
}

// ---------- shared: record a tuition payment ----------
function collectInvoicePayment(invoiceId, onDone) {
    openModal(`
        <h3>Record payment</h3>
        <div class="form-group"><label>Paid by</label>
            <select id="pay-method"><option value="CASH">Cash</option><option value="BANK">Bank transfer</option><option value="MOBILE">Mobile money</option></select>
        </div>
        <div class="form-group"><label>Receipt / reference (optional)</label><input type="text" id="pay-reference" maxlength="100" /></div>
        <div class="form-actions">
            <button class="btn btn-ghost" id="pay-cancel">Cancel</button>
            <button class="btn btn-success" id="pay-confirm">Mark as Paid</button>
        </div>`);
    document.getElementById('pay-cancel').addEventListener('click', closeModal);
    document.getElementById('pay-confirm').addEventListener('click', async () => {
        const method = document.getElementById('pay-method').value;
        const reference = document.getElementById('pay-reference').value.trim();
        const res = await apiFetch(`${API_BASE}/api/finance/invoices/${invoiceId}/mark-paid`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, reference }),
        });
        const data = await handleJsonResponse(res, 'Payment recorded.');
        if (data) { closeModal(); if (onDone) onDone(); }
    });
}

// ---------- FEE SETUP: fee per class level ----------
// Read-only table until "Edit Fees" is pressed. Saving asks for the password
// and sends the whole list (a blank level means "use the default amount").
let classRatesData = null;
let classRatesEditing = false;
async function loadClassRates() {
    const res = await apiFetch(`${API_BASE}/api/finance/class-rates`);
    if (!res.ok) return;
    classRatesData = await res.json();
    classRatesEditing = false;
    renderClassRates();
}
function rateChanged(inp) {
    const a = String(inp.value).trim(), b = String(inp.dataset.original).trim();
    return a === '' || b === '' ? a !== b : Number(a) !== Number(b);
}
function renderClassRates() {
    const d = classRatesData;
    if (!d) return;
    const body = document.getElementById('fee-class-rates-body');
    const defaultLabel = d.default_fee ? t('fin_fee_uses_default', { amount: fmtMoney(d.default_fee) }) : t('fin_fee_not_set');
    body.innerHTML = d.grades.length ? d.grades.map(g => {
        const v = d.rates[g];
        const has = v !== undefined && v !== null && v !== '';
        const cell = classRatesEditing
            ? `<div class="fee-input fee-input-sm"><span class="fee-input-affix">ETB</span><input type="number" min="0" step="0.01" inputmode="decimal" data-rate-level="${g}" data-original="${has ? Number(v) : ''}" value="${has ? Number(v) : ''}" placeholder="${escapeHtml(defaultLabel)}" aria-label="${escapeHtml(t('fin_fee_grade', { g }))}" /></div>`
            : (has ? `<span class="fee-amount">ETB ${fmtMoney(v)}</span>` : `<span class="fee-muted">${escapeHtml(defaultLabel)}</span>`);
        return `<tr><td><span class="fee-level"><span class="fee-level-chip">${gradeDisp(g)}</span>${escapeHtml(isKgLevel(g) ? gradeDisp(g) : t('fin_fee_grade', { g }))}</span></td><td>${cell}</td></tr>`;
    }).join('') : `<tr><td colspan="2">${t('fin_no_data')}</td></tr>`;
    document.getElementById('fee-class-rates-edit-btn').style.display = classRatesEditing || !d.grades.length ? 'none' : '';
    document.getElementById('fee-class-edit-actions').style.display = classRatesEditing ? '' : 'none';
    document.getElementById('fee-class-card').classList.toggle('is-editing', classRatesEditing);
    document.getElementById('fee-class-rates-hint').textContent = t('fin_fee_year_chip', { year: d.academic_year });
    if (classRatesEditing) {
        body.querySelectorAll('[data-rate-level]').forEach(inp => inp.addEventListener('input', () => {
            inp.closest('tr').classList.toggle('is-changed', rateChanged(inp));
        }));
        const first = body.querySelector('[data-rate-level]');
        if (first) first.focus();
    }
}

// ---------- FEE SETUP: document fees ----------
// What the Registrar charges for official documents, per reason (transfer /
// graduating). Read-only until "Edit Fees"; saving asks for the password.
let docFeesData = null;
let docFeesEditing = false;
async function loadDocumentFees() {
    const res = await apiFetch(`${API_BASE}/api/finance/document-fees`);
    if (!res.ok) return;
    docFeesData = await res.json();
    docFeesEditing = false;
    renderDocumentFees();
}
function renderDocumentFees() {
    const d = docFeesData;
    if (!d) return;
    document.getElementById('fee-doc-head').innerHTML =
        `<tr><th>${t('fin_docfee_col_document')}</th>${d.purposes.map(p => `<th>${escapeHtml(docPurposeLabel(p.key))}</th>`).join('')}</tr>`;
    document.getElementById('fee-doc-body').innerHTML = d.documents.map(doc => {
        const cells = d.purposes.map(p => {
            const v = d.rates[doc.key] ? d.rates[doc.key][p.key] : null;
            const has = v !== null && v !== undefined;
            if (docFeesEditing) {
                return `<td data-label="${escapeHtml(docPurposeLabel(p.key))}"><div class="fee-input fee-input-sm"><span class="fee-input-affix">ETB</span><input type="number" min="0" step="0.01" inputmode="decimal" data-doc="${doc.key}" data-purpose="${p.key}" data-original="${has ? Number(v) : ''}" value="${has ? Number(v) : ''}" placeholder="${escapeHtml(t('fin_fee_not_set'))}" aria-label="${escapeHtml(docTypeLabel(doc.key) + ' - ' + docPurposeLabel(p.key))}" /></div></td>`;
            }
            return `<td data-label="${escapeHtml(docPurposeLabel(p.key))}">${has ? (Number(v) === 0 ? `<span class="fee-amount">${t('fin_docfee_free')}</span>` : `<span class="fee-amount">ETB ${fmtMoney(v)}</span>`) : `<span class="fee-muted">${t('fin_fee_not_set')}</span>`}</td>`;
        }).join('');
        return `<tr><td><span class="fee-level">${escapeHtml(docTypeLabel(doc.key))}</span></td>${cells}</tr>`;
    }).join('');
    document.getElementById('fee-doc-edit-btn').style.display = docFeesEditing ? 'none' : '';
    document.getElementById('fee-doc-edit-actions').style.display = docFeesEditing ? '' : 'none';
    document.getElementById('fee-document-card').classList.toggle('is-editing', docFeesEditing);
    document.getElementById('fee-doc-hint').textContent = t('fin_docfee_hint');
    if (docFeesEditing) {
        const body = document.getElementById('fee-doc-body');
        body.querySelectorAll('[data-doc]').forEach(inp => inp.addEventListener('input', () => {
            inp.closest('td').classList.toggle('is-changed', rateChanged(inp));
        }));
        const first = body.querySelector('[data-doc]');
        if (first) first.focus();
    }
}

// ---------- STUDENTS & DUES ----------
let stuClassFilterLoaded = false;
async function loadStudentsDues() {
    if (SCHOOL_TYPE !== 'Private') return;
    if (!stuClassFilterLoaded) {
        const gr = await apiFetch(`${API_BASE}/api/school/grade-levels`);
        if (gr.ok) {
            const { grades } = await gr.json();
            document.getElementById('stu-class-filter').insertAdjacentHTML('beforeend', grades.map(g => `<option value="${g}">${isKgLevel(g) ? gradeDisp(g) : `Grade ${g}`}</option>`).join(''));
            stuClassFilterLoaded = true;
        }
    }
    const tbody = document.getElementById('fin-students-tbody');
    tbody.innerHTML = `<tr><td colspan="8">${t('fin_loading')}</td></tr>`;
    const params = new URLSearchParams({ status: document.getElementById('stu-status-filter').value });
    const cl = document.getElementById('stu-class-filter').value;
    const q = document.getElementById('stu-search-input').value.trim();
    if (cl) params.set('class_level', cl);
    if (q) params.set('search', q);
    const res = await apiFetch(`${API_BASE}/api/finance/students?${params}`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="8">${t('fin_load_error')}</td></tr>`; return; }
    const { summary, students } = await res.json();
    document.getElementById('stu-sum-students').textContent = summary.students;
    document.getElementById('stu-sum-due').textContent = summary.with_dues;
    document.getElementById('stu-sum-overdue').textContent = summary.overdue;
    document.getElementById('stu-sum-total').textContent = fmtMoney(summary.total_due);
    tbody.innerHTML = students.length ? students.map(r => {
        const covered = r.covered_kind ? `<span class="badge badge-waived">${escapeHtml(r.covered_kind.toLowerCase())} ${r.covered_percent}%</span> ` : '';
        const state = Number(r.overdue_months) > 0 ? '<span class="badge badge-overdue">overdue</span>'
            : Number(r.unpaid_months) > 0 ? '<span class="badge badge-pending">unpaid</span>'
            : '<span class="badge badge-paid">clear</span>';
        return `
        <tr>
            <td>${escapeHtml(r.student_name)} <span class="form-hint">${escapeHtml(r.student_id)}</span></td>
            <td>${escapeHtml(r.class_level != null ? gradeDisp(r.class_level) : '—')}${r.section ? ' ' + escapeHtml(r.section) : ''}</td>
            <td>${escapeHtml(r.guardian_name || '—')}${r.guardian_phone ? `<br><span class="form-hint">${escapeHtml(r.guardian_phone)}</span>` : ''}</td>
            <td>${covered}${state}</td>
            <td>${r.unpaid_months}</td>
            <td>${fmtMoney(r.amount_due)}</td>
            <td>${fmtDate(r.oldest_due)}</td>
            <td>
                <button class="btn btn-ghost btn-sm" data-statement="${escapeHtml(r.student_id)}" data-name="${escapeHtml(r.student_name)}">Statement</button>
                <button class="btn btn-ghost btn-sm" data-grant="${escapeHtml(r.student_id)}">Scholarship</button>
            </td>
        </tr>`;
    }).join('') : `<tr><td colspan="8">${t('fin_no_data')}</td></tr>`;
    tbody.querySelectorAll('[data-statement]').forEach(b => b.addEventListener('click', () => showStatement(b.dataset.statement, b.dataset.name)));
    tbody.querySelectorAll('[data-grant]').forEach(b => b.addEventListener('click', () => {
        navigateToPage('scholarships');
        document.getElementById('sch-student-id').value = b.dataset.grant;
    }));
}
async function showStatement(studentId, name) {
    const res = await apiFetch(`${API_BASE}/api/finance/students/${encodeURIComponent(studentId)}/invoices`);
    if (!res.ok) return showToast(t('fin_load_error'), 'error');
    const rows = await res.json();
    openModal(`
        <h3>${escapeHtml(name)} <span class="form-hint">${escapeHtml(studentId)}</span></h3>
        <div class="data-table-wrap"><table class="data-table">
            <thead><tr><th>Month</th><th>Amount</th><th>Due</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows.length ? rows.map(r => `
                <tr>
                    <td>${fmtInvoiceMonth(r)}${r.semester ? `<br><span class="form-hint">${escapeHtml(r.semester)}</span>` : ''}</td>
                    <td>${fmtMoney(r.amount)}${r.original_amount ? `<br><span class="form-hint">fee ${fmtMoney(r.original_amount)}</span>` : ''}</td>
                    <td>${fmtDate(r.due_date)}</td>
                    <td><span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status)}</span>${r.paid_method ? `<br><span class="form-hint">${escapeHtml(r.paid_method.toLowerCase())}${r.paid_reference ? ' · ' + escapeHtml(r.paid_reference) : ''}</span>` : ''}</td>
                    <td>${['pending', 'overdue'].includes(r.status) ? `<button class="btn btn-success btn-sm" data-pay="${r.invoice_id}">Mark paid</button>` : ''}</td>
                </tr>`).join('') : '<tr><td colspan="5">No invoices yet.</td></tr>'}</tbody>
        </table></div>
        <div class="form-actions"><button class="btn btn-ghost" id="stmt-close">Close</button></div>`, { wide: true });
    document.getElementById('stmt-close').addEventListener('click', closeModal);
    document.querySelectorAll('#fin-active-modal [data-pay]').forEach(b => b.addEventListener('click', () => {
        collectInvoicePayment(b.dataset.pay, () => { loadStudentsDues(); loadDashboard(); showStatement(studentId, name); });
    }));
}

// ---------- SCHOLARSHIPS, SPONSORS & FAMILY RULE ----------
async function loadScholarships() {
    if (SCHOOL_TYPE !== 'Private') return;
    const tbody = document.getElementById('fin-scholarships-tbody');
    tbody.innerHTML = `<tr><td colspan="7">${t('fin_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/finance/scholarships`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="7">${t('fin_load_error')}</td></tr>`; }
    else {
        const rows = await res.json();
        const label = { SCHOLARSHIP: 'School scholarship', SPONSOR: 'Sponsor', FAMILY: 'Family rule' };
        tbody.innerHTML = rows.length ? rows.map(r => `
            <tr>
                <td>${escapeHtml(r.student_name)} <span class="form-hint">${escapeHtml(r.student_id)}</span></td>
                <td>${escapeHtml(r.class_level != null ? gradeDisp(r.class_level) : '—')}</td>
                <td>${label[r.kind] || escapeHtml(r.kind)}${r.sponsor_name ? `<br><span class="form-hint">${escapeHtml(r.sponsor_name)}</span>` : ''}</td>
                <td>${r.coverage_percent}%</td>
                <td>${fmtDate(r.valid_from)} – ${fmtDate(r.valid_to)}</td>
                <td><span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status.toLowerCase())}</span></td>
                <td>${r.status === 'ACTIVE' ? `<button class="btn btn-danger btn-sm" data-revoke="${r.id}">Revoke</button>` : '—'}</td>
            </tr>`).join('') : `<tr><td colspan="7">${t('fin_no_data')}</td></tr>`;
        tbody.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
            if (!await showConfirmModal('Revoke this? The student goes back to paying the normal fee on their unpaid invoices.', { danger: true })) return;
            const r2 = await apiFetch(`${API_BASE}/api/finance/scholarships/${b.dataset.revoke}/revoke`, { method: 'POST' });
            if (await handleJsonResponse(r2, 'Revoked.')) { loadScholarships(); }
        }));
    }
    loadFamilyRule();
}
async function loadFamilyRule() {
    const res = await apiFetch(`${API_BASE}/api/finance/family-rule`);
    if (!res.ok) return;
    const { policy, families } = await res.json();
    document.getElementById('fam-enabled').checked = policy.enabled;
    document.getElementById('fam-threshold').value = policy.children_threshold;
    document.getElementById('fam-free').value = policy.free_count;
    document.getElementById('fam-rule').value = policy.free_child_rule;
    const box = document.getElementById('fam-families');
    if (!policy.enabled) { box.innerHTML = ''; return; }
    box.innerHTML = `<h3 style="margin:8px 0 12px">Families that qualify (${families.length})</h3>` + (families.length ? families.map(f => `
        <div class="widget" style="max-width:640px; margin-bottom:12px">
            <strong>${escapeHtml(f.guardian_name)}</strong> <span class="form-hint">${escapeHtml(f.phone || '')}</span>
            <p class="form-hint">${f.children.length} children enrolled · entitled to ${f.entitled} free · ${f.granted} granted</p>
            <table class="data-table"><tbody>${f.children.map(c => `
                <tr>
                    <td>${escapeHtml(c.name)} <span class="form-hint">${escapeHtml(c.student_id)}</span></td>
                    <td>${escapeHtml(isKgLevel(c.class_level) ? gradeDisp(c.class_level) : `Grade ${c.class_level}`)}</td>
                    <td>${c.monthly_fee != null ? fmtMoney(c.monthly_fee) : '—'}</td>
                    <td>${c.family_waiver_active ? '<span class="badge badge-waived">free place</span>'
                        : f.granted < f.entitled ? `<button class="btn ${c.student_id === f.suggested_student_id ? 'btn-accent' : 'btn-ghost'} btn-sm" data-fam-grant="${escapeHtml(c.student_id)}" data-guardian="${f.guardian_id}" data-cname="${escapeHtml(c.name)}">${c.student_id === f.suggested_student_id ? 'Grant (suggested)' : 'Grant free place'}</button>` : ''}</td>
                </tr>`).join('')}</tbody></table>
        </div>`).join('') : '<p class="form-hint">No parent has that many children enrolled right now.</p>');
    box.querySelectorAll('[data-fam-grant]').forEach(b => b.addEventListener('click', () => grantFamilyPlace(b.dataset.guardian, b.dataset.famGrant, b.dataset.cname)));
}
function grantFamilyPlace(guardian_id, student_id, name) {
    const today = new Date();
    const next = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate() - 1);
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    openModal(`
        <h3>Free place for ${escapeHtml(name)}</h3>
        <p class="form-hint">No monthly fee for the period below.</p>
        <div class="form-group"><label>From</label><input type="date" id="fam-from" value="${iso(today)}" /></div>
        <div class="form-group"><label>Until</label><input type="date" id="fam-to" value="${iso(next)}" /></div>
        <div class="form-actions">
            <button class="btn btn-ghost" id="fam-cancel">Cancel</button>
            <button class="btn btn-accent" id="fam-confirm">Grant</button>
        </div>`);
    attachEcPreview('fam-from', 'date');
    attachEcPreview('fam-to', 'date');
    document.getElementById('fam-cancel').addEventListener('click', closeModal);
    document.getElementById('fam-confirm').addEventListener('click', async () => {
        const res = await apiFetch(`${API_BASE}/api/finance/family-rule/grant`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guardian_id, student_id, valid_from: document.getElementById('fam-from').value, valid_to: document.getElementById('fam-to').value }),
        });
        if (await handleJsonResponse(res, 'Granted.')) { closeModal(); loadScholarships(); }
    });
}

// ---------- STUDENT SUBSCRIPTION ----------
// The student fee is paid at registration (verified under Verify Payments).
// This page lists every active student's status for the current EC month so
// Finance can record the later months of a monthly school, or correct a mistake.
let SUB_STUDENTS = [];
let SUB_BILLABLE = true;
let SUB_CYCLE = 'monthly';

async function initSubscriptionNav() {
    const li = document.getElementById('fin-nav-subscription-li');
    if (!li) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/finance/subscription`);
        if (!res.ok) return;
        const d = await res.json();
        li.style.display = d && d.enabled ? '' : 'none';
    } catch (e) { /* menu item just stays hidden */ }
}
async function loadSubscription() {
    const tbody = document.getElementById('fin-subscription-tbody');
    tbody.innerHTML = `<tr><td colspan="4">${t('fin_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/finance/subscription`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('fin_load_error')}</td></tr>`; return; }
    const d = await res.json();
    if (!d.enabled) {
        document.getElementById('fin-nav-subscription-li').style.display = 'none';
        tbody.innerHTML = `<tr><td colspan="4">Subscription isn't turned on for your school.</td></tr>`;
        return;
    }
    SUB_CYCLE = d.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
    SUB_BILLABLE = !!d.billable;
    SUB_STUDENTS = d.students || [];
    const monthName = d.period ? `${d.period.month_name} ${d.period.ec_year} ${t('fin_ec_suffix')}` : '';
    document.getElementById('sub-page-sub').textContent = SUB_CYCLE === 'yearly'
        ? `Yearly subscription: paid once at registration and covers the rest of the year. Status shown for ${monthName}.`
        : `Monthly subscription: paid at registration for the first month, then each month. Status shown for ${monthName}.`;
    document.getElementById('sub-stat-fee').textContent = `ETB ${fmtMoney(d.student_fee)}${SUB_CYCLE === 'yearly' ? ' / year' : ' / month'}`;
    document.getElementById('sub-stat-paid').textContent = d.summary.paid;
    document.getElementById('sub-stat-unpaid').textContent = d.summary.unpaid;
    renderSubscriptionRows();
    loadSubscriptionReportStatus();
}
// Shows when this month's totals were last reported to the Principal, and
// keeps the button disabled outside a billing month (Pagume).
// True when this school reports for the whole EC year (yearly billing cycle).
let SUB_REPORT_IS_YEAR = false;
async function loadSubscriptionReportStatus() {
    const el = document.getElementById('sub-report-status');
    const btn = document.getElementById('sub-report-btn');
    if (!el) return;
    el.textContent = '';
    try {
        const res = await apiFetch(`${API_BASE}/api/finance/subscription/report`);
        if (!res.ok) return;
        const d = await res.json();
        SUB_REPORT_IS_YEAR = !!(d.period && d.period.is_year);
        if (btn) btn.disabled = !d.billable;
        const last = (d.reports || [])[0];
        el.textContent = last
            ? t('fin_sub_report_last', { date: fmtDateText(last.sent_at), amount: fmtMoney(last.amount_collected), paid: last.students_paid, unpaid: last.students_unpaid })
            : t(SUB_REPORT_IS_YEAR ? 'fin_sub_report_none_year' : 'fin_sub_report_none');
    } catch (e) { /* the status line just stays empty */ }
}
// Sends this month's student subscription totals to the Principal, who
// deposits the money to the Super Admin's account and then reports on to the
// Super Admin. The server computes the figures itself; only the password
// (and nothing else) is sent from here.
async function reportSubscriptionToPrincipal() {
    const btn = document.getElementById('sub-report-btn');
    if (btn) btn.disabled = true;
    try {
        const data = await sendWithPassword(`${API_BASE}/api/finance/subscription/report`, 'POST', {}, {
            successMsg: t('fin_sub_report_sent'),
            title: t('fin_sub_report_title'),
            description: t(SUB_REPORT_IS_YEAR ? 'fin_sub_report_desc_year' : 'fin_sub_report_desc'),
            confirmLabel: t('fin_sub_report_confirm'),
        });
        if (data) await loadSubscriptionReportStatus();
    } finally {
        if (btn) btn.disabled = false;
    }
}
function renderSubscriptionRows() {
    const tbody = document.getElementById('fin-subscription-tbody');
    const filter = document.getElementById('sub-status-filter').value;
    const q = document.getElementById('sub-search-input').value.trim().toLowerCase();
    const rows = SUB_STUDENTS.filter(s =>
        (filter === 'all' || (filter === 'paid') === s.paid)
        && (!q || s.name.toLowerCase().includes(q) || String(s.student_id).toLowerCase().includes(q)));
    tbody.innerHTML = rows.length ? rows.map(s => `
        <tr>
            <td>${escapeHtml(s.name)} <span class="form-hint">${escapeHtml(s.student_id)}</span></td>
            <td>${escapeHtml(s.class_label)}</td>
            <td><span class="badge ${s.paid ? 'badge-paid' : 'badge-pending'}">${s.paid ? 'Paid' : 'Not paid'}</span></td>
            <td>${s.paid
                ? `<button class="btn btn-ghost btn-sm" data-sub-undo="${escapeHtml(s.student_id)}" ${SUB_BILLABLE ? '' : 'disabled'}>Undo</button>`
                : `<button class="btn btn-success btn-sm" data-sub-paid="${escapeHtml(s.student_id)}" ${SUB_BILLABLE ? '' : 'disabled'}>Mark paid</button>`}</td>
        </tr>`).join('') : `<tr><td colspan="4">${t('fin_no_data')}</td></tr>`;
    tbody.querySelectorAll('[data-sub-paid]').forEach(b => b.addEventListener('click', () => setSubscriptionPaid(b.dataset.subPaid, true)));
    tbody.querySelectorAll('[data-sub-undo]').forEach(b => b.addEventListener('click', () => setSubscriptionPaid(b.dataset.subUndo, false)));
}
async function setSubscriptionPaid(studentId, paid) {
    const student = SUB_STUDENTS.find(s => s.student_id === studentId);
    const name = student ? student.name : studentId;
    const msg = paid
        ? (SUB_CYCLE === 'yearly'
            ? `Mark ${name} as paid for the rest of the year?`
            : `Mark ${name} as paid for this month?`)
        : (SUB_CYCLE === 'yearly'
            ? `Undo ${name}'s payment? This clears the whole year's subscription for this student.`
            : `Undo ${name}'s payment for this month?`);
    if (!(await showConfirmModal(msg, { danger: !paid }))) return;
    const res = await apiFetch(`${API_BASE}/api/finance/subscription/students/${encodeURIComponent(studentId)}/paid`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid }),
    });
    if (await handleJsonResponse(res, paid ? 'Marked as paid.' : 'Marked as unpaid.')) loadSubscription();
}
function wireSubscription() {
    document.getElementById('sub-refresh-btn').addEventListener('click', loadSubscription);
    document.getElementById('sub-report-btn').addEventListener('click', reportSubscriptionToPrincipal);
    document.getElementById('sub-status-filter').addEventListener('change', renderSubscriptionRows);
    document.getElementById('sub-search-input').addEventListener('input', renderSubscriptionRows);
}

function wireFinanceExtras() {
    document.getElementById('docfee-refresh-btn').addEventListener('click', loadDocFeeApprovals);
    document.getElementById('docfee-status-filter').addEventListener('change', loadDocFeeApprovals);
    document.getElementById('docfee-search-input').addEventListener('keydown', e => { if (e.key === 'Enter') loadDocFeeApprovals(); });
    document.getElementById('fee-doc-edit-btn').addEventListener('click', () => { docFeesEditing = true; renderDocumentFees(); });
    document.getElementById('fee-doc-cancel-btn').addEventListener('click', () => { docFeesEditing = false; renderDocumentFees(); });
    document.getElementById('fee-doc-save-btn').addEventListener('click', async () => {
        const inputs = [...document.querySelectorAll('#fee-doc-body [data-doc]')];
        if (!inputs.some(rateChanged)) return showToast(t('fin_fee_no_changes'), 'warning');
        const rates = inputs.map(i => ({ doc_type: i.dataset.doc, purpose: i.dataset.purpose, amount: i.value }));
        const data = await sendWithPassword(`${API_BASE}/api/finance/document-fees`, 'PUT', { rates }, {
            successMsg: t('fin_docfee_saved'), description: t('fin_docfee_save_desc'), confirmLabel: t('fin_pw_confirm_save'),
        });
        if (data) loadDocumentFees();
    });
    document.getElementById('fee-class-rates-edit-btn').addEventListener('click', () => { classRatesEditing = true; renderClassRates(); });
    document.getElementById('fee-class-rates-cancel-btn').addEventListener('click', () => { classRatesEditing = false; renderClassRates(); });
    document.getElementById('fee-class-rates-save-btn').addEventListener('click', async () => {
        const inputs = [...document.querySelectorAll('#fee-class-rates-body [data-rate-level]')];
        if (!inputs.some(rateChanged)) return showToast(t('fin_fee_no_changes'), 'warning');
        const rates = inputs.map(i => ({ class_level: Number(i.dataset.rateLevel), monthly_fee: i.value }));
        const data = await sendWithPassword(`${API_BASE}/api/finance/class-rates`, 'PUT', { rates }, {
            successMsg: t('fin_fee_class_saved'), description: t('fin_pw_desc_save'), confirmLabel: t('fin_pw_confirm_save'),
        });
        if (data) loadClassRates();
    });

    document.getElementById('stu-refresh-btn').addEventListener('click', loadStudentsDues);
    document.getElementById('stu-status-filter').addEventListener('change', loadStudentsDues);
    document.getElementById('stu-class-filter').addEventListener('change', loadStudentsDues);
    document.getElementById('stu-search-input').addEventListener('keydown', e => { if (e.key === 'Enter') loadStudentsDues(); });

    document.getElementById('sch-kind').addEventListener('change', e => {
        document.getElementById('sch-sponsor-group').style.display = e.target.value === 'SPONSOR' ? '' : 'none';
    });
    document.getElementById('sch-save-btn').addEventListener('click', async () => {
        const body = {
            student_id: document.getElementById('sch-student-id').value.trim(),
            kind: document.getElementById('sch-kind').value,
            sponsor_name: document.getElementById('sch-sponsor-name').value.trim(),
            coverage_percent: document.getElementById('sch-percent').value,
            valid_from: document.getElementById('sch-from').value,
            valid_to: document.getElementById('sch-to').value,
            note: document.getElementById('sch-note').value.trim(),
        };
        if (!body.student_id || !body.valid_from || !body.valid_to) return showToast('Enter the student ID and the period covered.', 'error');
        const res = await apiFetch(`${API_BASE}/api/finance/scholarships`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (await handleJsonResponse(res, 'Saved.')) {
            ['sch-student-id', 'sch-sponsor-name', 'sch-from', 'sch-to', 'sch-note'].forEach(id => { document.getElementById(id).value = ''; });
            document.getElementById('sch-percent').value = 100;
            loadScholarships();
        }
    });
    document.getElementById('fam-save-btn').addEventListener('click', async () => {
        const res = await apiFetch(`${API_BASE}/api/finance/family-rule`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: document.getElementById('fam-enabled').checked,
                children_threshold: document.getElementById('fam-threshold').value,
                free_count: document.getElementById('fam-free').value,
                free_child_rule: document.getElementById('fam-rule').value,
            }),
        });
        if (await handleJsonResponse(res, 'Family rule saved.')) loadFamilyRule();
    });
}

document.addEventListener('DOMContentLoaded', checkAuthAndInit);

// Live refresh: when the server says something changed (a Registrar just
// submitted a payment, a document fee needs approval, ...), refresh the badge
// and silently reload the open page if it is one of the request/payment
// lists — never while the person is typing or a dialog is open.
const FIN_LIVE_PAGES = new Set(['dashboard', 'verify-payments', 'document-fees', 'invoices', 'overdue-reminders']);
function refreshFinanceActivePageSilently() {
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    if (document.querySelector('.modal-overlay, .confirm-overlay, [role="dialog"]')) return;
    const active = document.querySelector('.nav-link[data-page].active');
    const page = active && active.dataset.page;
    if (!page || !FIN_LIVE_PAGES.has(page)) return;
    const loader = PAGE_LOADERS[page];
    if (loader) loader();
}
window.onLiveChange(() => refreshDocFeeBadge());
window.onLiveChange(refreshFinanceActivePageSilently);
