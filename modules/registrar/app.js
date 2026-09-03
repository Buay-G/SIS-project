// --- 0. Current User / Role Gating ---
// Registrar-only tabs: a Recorder can see these nav buttons but clicking
// them shows the security intercept instead of opening the tab.
// TODO: if the recorder/registrar split later covers more tabs (section
// setup, transfers, template hub, etc.), add their tab IDs here.
const REGISTRAR_ONLY_TABS = ['recorder-mgmt', 'section-setup', 'placement-wizard', 'documents', 'templates', 'graduation-wizard'];

let currentUser = null;

async function loadCurrentUser() {
    try {
        const res = await fetch('http://localhost:3001/api/me', { credentials: 'include' });
        if (!res.ok) return;
        currentUser = await res.json();
        applyRolePermissions();
        applyProfileChrome();
        if (currentUser.is_registrar) {
            loadRegistrarNotifications();
            setInterval(loadRegistrarNotifications, 60000);
        }
    } catch (err) {
        console.error("Could not load current user:", err);
    }
}

// --- 0b. Ethiopian Calendar (E.C.) — mandatory primary date format ---
// Ported from the standard Gregorian<->Ethiopian conversion algorithm and
// verified against known reference dates (e.g. 11 Sep 2024 = Meskerem 1,
// 2017 E.C.). Every date shown in this portal leads with E.C., Gregorian
// in brackets — see formatDateBilingual below.
const ETHIOPIAN_MONTH_NAMES_EN = ['Meskerem', 'Tikimt', 'Hidar', 'Tahsas', 'Tir', 'Yekatit', 'Megabit', 'Miazia', 'Ginbot', 'Sene', 'Hamle', 'Nehase', 'Pagume'];
const ETHIOPIAN_MONTH_NAMES_AM = ['መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሳስ', 'ጥር', 'የካቲት', 'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜ'];

function _ethStartDayOfYear(year) {
    const newYearDay = Math.floor(year / 100) - Math.floor(year / 400) - 4;
    return ((year - 1) % 4 === 3) ? newYearDay + 1 : newYearDay;
}

function gregorianToEthiopian(dateInput) {
    const d = new Date(dateInput);
    const year = d.getFullYear(), month = d.getMonth() + 1, date = d.getDate();

    const gregorianMonths = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const ethiopianMonths = [0, 30, 30, 30, 30, 30, 30, 30, 30, 30, 5, 30, 30, 30, 30];
    if ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) gregorianMonths[2] = 29;

    let ethiopianYear = year - 8;
    if (ethiopianYear % 4 === 3) ethiopianMonths[10] = 6;

    const newYearDay = _ethStartDayOfYear(year - 8);

    let until = 0;
    for (let i = 1; i < month; i++) until += gregorianMonths[i];
    until += date;

    const tahissas = newYearDay - 3;
    ethiopianMonths[1] = tahissas;

    let m, ethiopianDate;
    for (m = 1; m < ethiopianMonths.length; m++) {
        if (until <= ethiopianMonths[m]) {
            ethiopianDate = (m === 1 || ethiopianMonths[m] === 0) ? until + (30 - tahissas) : until;
            break;
        } else {
            until -= ethiopianMonths[m];
        }
    }
    if (m > 10) ethiopianYear += 1;

    const order = [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1, 2, 3, 4];
    return { year: ethiopianYear, month: order[m], day: ethiopianDate };
}

// E.C. primary, Gregorian in brackets — e.g. "18 Hamle 2018 E.C. (25 Jul 2026)".
function formatDateBilingual(dateInput) {
    if (!dateInput) return '—';
    const d = new Date(dateInput);
    if (isNaN(d)) return '—';
    const eth = gregorianToEthiopian(d);
    const lang = (typeof getCurrentLang === 'function') ? getCurrentLang() : 'en';
    const monthName = (lang === 'am' ? ETHIOPIAN_MONTH_NAMES_AM : ETHIOPIAN_MONTH_NAMES_EN)[eth.month - 1];
    const gregorianStr = d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
    return `${eth.day} ${monthName} ${eth.year} E.C. (${gregorianStr})`;
}

// Year-only version of formatDateBilingual, for labels where the exact
// day doesn't matter — e.g. "Enrolled: 2016 E.C. (2023)" on the Student
// Registry. Same E.C.-primary, Gregorian-in-brackets rule.
function formatYearBilingual(dateInput) {
    if (!dateInput) return null;
    const d = new Date(dateInput);
    if (isNaN(d)) return null;
    const eth = gregorianToEthiopian(d);
    return `${eth.year} E.C. (${d.getFullYear()})`;
}

// Re-render whatever's currently loaded so dynamic (non-data-i18n) text —
// list items, dates, alerts built in JS — picks up the new language too.
// i18n.js calls this automatically after setLang() via window.onSisLangChange.
window.onSisLangChange = function () {
    if (!currentUser) return;
    applyProfileChrome();
    loadApprovedTransferRequests();
    loadOutgoingTransfers();
    loadIncomingTransfers();
    if (currentUser.is_registrar || currentUser.is_recorder) {
        loadStudentRegistry();
    }
    if (currentUser.is_registrar) {
        loadSections();
        loadBulkSectionOptions();
        loadUnassignedQueue();
        loadPlacementRegistered();
        loadPlacementPromoted();
        loadRecorders();
        loadIssuanceLog();
        loadGraduationEligible();
        loadGraduationHistory();
    }
};

function isRecorderOnly() {
    return !!currentUser && currentUser.role === 'teachers' && currentUser.is_recorder && !currentUser.is_registrar;
}

function applyRolePermissions() {
    if (!currentUser) return;
    // Promotion/Stream is shared ground between Registrar and Recorder
    // (like Students / New Entry / Information Update), unlike the
    // Registrar-only tabs below — so it's shown to either role rather
    // than gated behind currentUser.is_registrar.
    const promotionNav = document.getElementById('nav-promotion');
    if (promotionNav) {
        promotionNav.style.display = (currentUser.is_registrar || currentUser.is_recorder) ? 'block' : 'none';
    }
    const mgmtNav = document.getElementById('nav-recorder-mgmt');
    if (mgmtNav) {
        mgmtNav.style.display = currentUser.is_registrar ? 'block' : 'none';
    }
    const sectionSetupNav = document.getElementById('nav-section-setup');
    if (sectionSetupNav) {
        sectionSetupNav.style.display = currentUser.is_registrar ? 'block' : 'none';
    }
    const placementNav = document.getElementById('nav-placement-wizard');
    if (placementNav) {
        placementNav.style.display = currentUser.is_registrar ? 'block' : 'none';
    }
    // Transfer Hub is shared ground — visible to the Registrar and to any
    // assigned Recorder, unlike the admin-only tabs.
    const transferNav = document.getElementById('nav-transfer-hub');
    if (transferNav) {
        transferNav.style.display = (currentUser.is_registrar || currentUser.is_recorder) ? 'block' : 'none';
    }
    const documentsNav = document.getElementById('nav-documents');
    if (documentsNav) {
        documentsNav.style.display = currentUser.is_registrar ? 'block' : 'none';
    }
    const templatesNav = document.getElementById('nav-templates');
    if (templatesNav) {
        templatesNav.style.display = currentUser.is_registrar ? 'block' : 'none';
    }
    // Student Registry — shared ground like Transfer Hub: a Recorder
    // handles day-to-day registration, so they can look students up too,
    // just read-only (no history/placement actions beyond viewing).
    const studentsNav = document.getElementById('nav-students');
    if (studentsNav) {
        studentsNav.style.display = (currentUser.is_registrar || currentUser.is_recorder) ? 'block' : 'none';
    }
    const graduationNav = document.getElementById('nav-graduation-wizard');
    if (graduationNav) {
        graduationNav.style.display = currentUser.is_registrar ? 'block' : 'none';
    }
    if (currentUser.is_registrar) {
        loadRecorders();
        loadEligibleTeachers();
        loadSections();
        loadBulkSectionOptions();
        loadUnassignedQueue();
        loadPlacementRegistered();
        loadPlacementPromoted();
        loadIssuanceLog();
        loadGraduationEligible();
        loadGraduationHistory();
    }
    if (currentUser.is_registrar || currentUser.is_recorder) {
        loadApprovedTransferRequests();
        loadOutgoingTransfers();
        loadIncomingTransfers();
        loadDashboardStats();
        loadAcademicYearOptions();
        loadStudentRegistry();
    }
}

// --- 1. Tab Navigation ---
function switchTab(tabId) {
    if (REGISTRAR_ONLY_TABS.includes(tabId) && isRecorderOnly()) {
        showRecorderIntercept();
        return;
    }
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.getElementById(tabId).classList.add('active');
    updateTopbarSectionName(tabId);
    closeSidebar();
}

// The top bar used to repeat the school name (already shown in the
// sidebar header), which didn't tell staff which section of the app
// they were currently in. It now mirrors whichever sidebar nav item is
// active, so it reads e.g. "New Entrant Registration" or "Promotion/Stream"
// instead. Pulls the label straight from the matching sidebar button's
// <span> rather than duplicating i18n keys, so it stays correct
// automatically whether the label is in English or Amharic.
function updateTopbarSectionName(tabId) {
    const topbarLabel = document.getElementById('topbar-school-name');
    if (!topbarLabel) return;
    const navBtn = document.querySelector(`.sidebar-nav [data-tab="${tabId}"]`);
    const label = navBtn ? navBtn.querySelector('span')?.textContent?.trim() : null;
    topbarLabel.textContent = label || '—';
}

// --- Mobile sidebar drawer: hamburger opens it, tapping the dimmed
// overlay (or picking a nav item, via switchTab above) closes it again.
// No-op on desktop widths since .sidebar-open only has an effect inside
// the <=900px media query.
function toggleSidebar() {
    const container = document.querySelector('.dashboard-container');
    if (!container) return;
    const isOpen = container.classList.toggle('sidebar-open');
    const hamburger = document.querySelector('.sidebar-hamburger');
    if (hamburger) hamburger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function closeSidebar() {
    const container = document.querySelector('.dashboard-container');
    if (!container) return;
    container.classList.remove('sidebar-open');
    const hamburger = document.querySelector('.sidebar-hamburger');
    if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
}

function showRecorderIntercept() {
    document.getElementById('recorder-intercept-modal').style.display = 'block';
}

function closeRecorderIntercept() {
    document.getElementById('recorder-intercept-modal').style.display = 'none';
    // TODO: point this at the real teacher-portal entry route.
    window.location.href = '/teachers/index.html';
}

document.addEventListener('DOMContentLoaded', loadCurrentUser);
document.addEventListener('DOMContentLoaded', initIconsWithRetry);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebar();
});

// Icons (including the topbar bell/settings buttons) render blank
// whenever `if (window.lucide) lucide.createIcons()` runs before the
// CDN <script> has actually finished attaching `window.lucide` — a
// slow network, an ad/tracker blocker touching jsdelivr, or a
// corporate firewall all cause exactly this, and the old one-shot
// check just silently gave up forever with no retry and no visible
// error. This waits for the library (a few short retries covers real
// network latency), logs a clear console warning if it truly never
// shows up instead of failing silently, and is exported so any code
// path that injects fresh `data-lucide` markup after the initial
// paint (toasts, dynamically-built lists) can re-run it too.
function initIconsWithRetry(attemptsLeft = 20) {
    if (window.lucide) {
        lucide.createIcons();
        return;
    }
    if (attemptsLeft <= 0) {
        console.warn('Lucide icons failed to load — sidebar nav icons will not render. Check that cdn.jsdelivr.net is reachable. (The notification bell and settings gear are unaffected — they now render from self-hosted SVG images.)');
        return;
    }
    setTimeout(() => initIconsWithRetry(attemptsLeft - 1), 150);
}
window.refreshIcons = () => { if (window.lucide) lucide.createIcons(); };

// --- 1c. Event wiring ---
// Every interactive element that used to carry an inline onclick/onchange
// attribute now carries a data-tab / data-action / data-onchange attribute
// instead (CSP's default script-src blocks inline handlers, and this keeps
// behavior out of the markup). Three delegated listeners cover the bulk of
// them; a handful of elements that don't fit the generic pattern (reading a
// live variable, a keyboard shortcut, a file input's own element) get their
// own explicit listener below that.
document.addEventListener('DOMContentLoaded', () => {
    // data-tab="X" -> switchTab('X'). Used by every sidebar nav button plus
    // the "Browse every registered student" button on the dashboard.
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-tab]');
        if (el) switchTab(el.dataset.tab);
    });

    // data-action="fnName" [data-arg="x"] | [data-args='["x","y"]'] -> fnName(x)
    // / fnName(x, y) / fnName(). Covers every other click-to-run-a-function
    // button/link/icon, including rows built dynamically via innerHTML
    // (see escAttr/dataArg/dataArgs helpers used when building those strings).
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const fn = window[el.dataset.action];
        if (typeof fn !== 'function') {
            console.error(`No handler function named "${el.dataset.action}"`);
            return;
        }
        if ('args' in el.dataset) fn(...JSON.parse(el.dataset.args));
        else if ('arg' in el.dataset) fn(el.dataset.arg);
        else fn();
    });

    // data-onchange="fnName" -> fnName() on change. Covers the grade/stream
    // selects and the status/grade filters on the student registry.
    document.addEventListener('change', (e) => {
        const el = e.target.closest('[data-onchange]');
        if (!el) return;
        const fn = window[el.dataset.onchange];
        if (typeof fn === 'function') fn();
    });
    // data-onchange-checked="fnName" [data-arg="x"] -> fnName(x, this.checked).
    // For checkboxes whose handler needs the row's id plus the new state
    // (e.g. toggling a section active/inactive).
    document.addEventListener('change', (e) => {
        const el = e.target.closest('[data-onchange-checked]');
        if (!el) return;
        const fn = window[el.dataset.onchangeChecked];
        if (typeof fn === 'function') fn(el.dataset.arg, el.checked);
    });
    // data-onchange-self="fnName" -> fnName(this). For the "select all"
    // graduation checkbox, whose handler needs the checkbox element itself.
    document.addEventListener('change', (e) => {
        const el = e.target.closest('[data-onchange-self]');
        if (!el) return;
        const fn = window[el.dataset.onchangeSelf];
        if (typeof fn === 'function') fn(el);
    });

    // Student search box: Enter runs the same search as the Search button.
    document.getElementById('student_registry_search')
        ?.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') loadStudentRegistry();
        });

    // Profile avatar image + account name: keyboard-activatable
    // (role="button", tabindex=0) since neither is a real <button>.
    document.getElementById('topbar-avatar')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openProfileSettings();
        }
    });
    document.getElementById('topbar-account-name')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openProfileSettings();
        }
    });

    // Sidebar footer links: prevent the "#" href from jumping the page.
    document.getElementById('return-to-portal-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        returnToPortal();
    });
    document.getElementById('sidebar-logout-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        registrarLogout();
    });

    // Documents tab: these three read whichever student is currently loaded
    // at click time, so they need a live closure rather than a static
    // data-arg value.
    document.getElementById('doc-preview-report-card-btn')
        ?.addEventListener('click', () => previewReportCard(currentDocStudentId));
    document.getElementById('doc-preview-transcript-btn')
        ?.addEventListener('click', () => previewTranscript(currentDocStudentId));
    document.getElementById('doc-download-id-card-btn')
        ?.addEventListener('click', () => downloadIdCard(currentDocStudentId));

    // Modal backdrops: clicking the dimmed overlay itself (not its content
    // box) closes the modal.
    document.getElementById('student-history-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeStudentHistory();
    });
    document.getElementById('profile-settings-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeProfileSettings();
    });
    document.getElementById('queue-view-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeQueueViewModal();
    });

    // Profile settings file inputs: uploading passes the input element
    // itself, same as the old onchange="fn(this)" did.
    document.getElementById('settings-avatar-input')?.addEventListener('change', function () {
        uploadRegistrarAvatar(this);
    });
    document.getElementById('settings-signature-input')?.addEventListener('change', function () {
        uploadRegistrarSignature(this);
    });
});

// --- 1d. Helpers for building data-action markup from a template string ---
// Rows rendered via innerHTML (recorder list, sections, student registry,
// transfer lists, notifications, etc.) need the same data-action wiring the
// static HTML uses, but the value being embedded (a student ID, a name) has
// to be HTML-attribute-safe first, or a name containing a quote could break
// out of the attribute or wire up the wrong handler.
function escAttr(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
// e.g. `<button ${dataArg('viewStudentHistory', s.student_id)}>` ->
// data-action="viewStudentHistory" data-arg="NHS2401001"
function dataArg(action, value) {
    return `data-action="${escAttr(action)}" data-arg="${escAttr(value)}"`;
}
// e.g. `<button ${dataArgs('runPlacement', [b.class_level, b.stream])}>` ->
// data-action="runPlacement" data-args="[10,&quot;Natural&quot;]"
function dataArgs(action, values) {
    return `data-action="${escAttr(action)}" data-args="${escAttr(JSON.stringify(values))}"`;
}
// e.g. `<input type="checkbox" ${dataOnchangeChecked('toggleSectionActive', s.id)} />`
function dataOnchangeChecked(fnName, arg) {
    return `data-onchange-checked="${escAttr(fnName)}" data-arg="${escAttr(arg)}"`;
}

// --- 1b. Toasts & Confirm dialogs ---
// Replaces native alert()/confirm() with a styled, non-blocking toast and a
// Promise-based confirm modal, so every call site just swaps the function
// name (alert -> showAlert) or awaits the result (confirm -> showConfirm).
function ensureToastContainer() {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-atomic', 'true');
        document.body.appendChild(container);
    }
    return container;
}

function showAlert(message, type) {
    if (!message) return;
    if (!type) {
        const lower = String(message).toLowerCase();
        type = /error|fail|not found|required|invalid|denied|could not|connection|choose|enter a|select a/.test(lower)
            ? 'error' : 'success';
    }
    const container = ensureToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const icon = document.createElement('i');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('data-lucide', type === 'error' ? 'alert-triangle' : 'check-circle-2');

    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', t('reg_toast_dismiss'));
    closeBtn.textContent = '\u00d7';

    const remove = () => {
        toast.classList.add('toast-hide');
        setTimeout(() => toast.remove(), 200);
    };
    closeBtn.addEventListener('click', remove);

    toast.appendChild(icon);
    toast.appendChild(text);
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    if (window.lucide) lucide.createIcons({ root: toast });
    setTimeout(remove, 6000);
}

// Promise-based replacement for confirm() — resolves true/false, so call
// sites just add `await` in front (they're all inside async functions).
function showConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        if (!modal) { resolve(window.confirm(message)); return; }
        document.getElementById('confirm-modal-message').textContent = message;
        modal.style.display = 'flex';

        const okBtn = document.getElementById('confirm-modal-ok');
        const cancelBtn = document.getElementById('confirm-modal-cancel');

        const cleanup = (result) => {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKeydown);
            resolve(result);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onKeydown = (e) => { if (e.key === 'Escape') cleanup(false); };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKeydown);
        cancelBtn.focus();
    });
}

// Promise-based password-confirmation modal — used before any action
// that moves a student out of the school (transfer start/cancel), so a
// shared or unlocked screen can't trigger one by accident. Resolves to
// the entered password on Confirm, or null on Cancel/Escape. serverError
// can be set (from a failed attempt) to show inline under the field the
// next time this same prompt is reused for a retry.
function showPasswordPrompt(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('password-confirm-modal');
        if (!modal) { resolve(window.prompt(message)); return; }
        document.getElementById('password-confirm-modal-message').textContent = message;
        const input = document.getElementById('password-confirm-modal-input');
        const errorEl = document.getElementById('password-confirm-modal-error');
        input.value = '';
        errorEl.style.display = 'none';
        errorEl.textContent = '';
        modal.style.display = 'flex';

        const okBtn = document.getElementById('password-confirm-modal-ok');
        const cancelBtn = document.getElementById('password-confirm-modal-cancel');

        const cleanup = (result) => {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKeydown);
            resolve(result);
        };
        const onOk = () => cleanup(input.value);
        const onCancel = () => cleanup(null);
        const onKeydown = (e) => {
            if (e.key === 'Escape') cleanup(null);
            if (e.key === 'Enter') onOk();
        };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKeydown);
        input.focus();
    });
}

// --- 2. Dynamic Stream Logic (Grade 9-12) ---
function updateStreamOptions() {
    const grade = document.getElementById('reg_grade').value;
    const streamSelect = document.getElementById('reg_stream');
    
    streamSelect.innerHTML = ''; 
    
    if (grade == '9' || grade == '10') {
        streamSelect.innerHTML = '<option value="General">General</option>';
    } else if (grade == '11' || grade == '12') {
        streamSelect.innerHTML = `
            <option value="Natural Science">Natural Science</option>
            <option value="Social Science">Social Science</option>
        `;
    } else {
        streamSelect.innerHTML = '<option value="">Select Stream</option>';
    }
}

// --- 3. Database Interactions ---

async function submitRegistration() {
    const btn = document.querySelector('button[data-action="submitRegistration"]');
    const originalText = btn.innerText;
    
    const data = {
        fayda_number: document.getElementById('reg_fayda').value,
        phone_number: document.getElementById('reg_phone').value,
        first_name: document.getElementById('reg_first').value,
        middle_name: document.getElementById('reg_middle').value,
        last_name: document.getElementById('reg_last').value,
        class_level: document.getElementById('reg_grade').value,
        sex: document.getElementById('reg_sex').value,
        stream: document.getElementById('reg_stream').value
    };

    btn.innerText = "Registering...";
    btn.disabled = true;

    try {
        const res = await fetch('http://localhost:3001/api/register', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        const result = await res.json();

        if (res.ok) {
            const successMsg = document.querySelector('#success-modal p');
            successMsg.innerText = `Student Registered Successfully! ID: ${result.student_id} | Section: Awaiting Placement | PC: ${result.assigned_pc}`;
            showSuccess('registration');
            document.getElementById('registration-form').reset();
            document.getElementById('reg_stream').innerHTML = '<option value="">Select Stream</option>';
        } else {
            showAlert("Registration Failed: " + (result.error || "Unknown error"));
        }
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function fetchStudent() {
    const id = document.getElementById('search-id').value;
    if (!id) return showAlert("Please enter an ID!");

    const res = await fetch(`http://localhost:3001/api/student/${id}`, { credentials: 'include' });
    if (res.ok) {
        const data = await res.json();
        document.getElementById('upd_id').value = data.student_id;
        document.getElementById('upd_first').value = data.first_name;
        document.getElementById('upd_middle').value = data.middle_name;
        document.getElementById('upd_last').value = data.last_name;
        document.getElementById('upd_class').value = data.class_level;
        document.getElementById('upd_section').value = data.section;
        document.getElementById('upd_stream').value = data.stream;
        document.getElementById('upd_phone').value = data.phone_number;
        document.getElementById('upd_fayda').value = data.fayda_number;
        document.getElementById('upd_sex').value = data.sex;
    } else {
        showAlert("Student not found!");
    }
}

async function submitUpdate() {
    const id = document.getElementById('upd_id').value;
    if (!id) return showAlert("Search for a student first!");
    
    const data = {
        first_name: document.getElementById('upd_first').value,
        middle_name: document.getElementById('upd_middle').value,
        last_name: document.getElementById('upd_last').value,
        phone_number: document.getElementById('upd_phone').value,
        fayda_number: document.getElementById('upd_fayda').value,
        sex: document.getElementById('upd_sex').value,
        class_level: document.getElementById('upd_class').value, 
        stream: document.getElementById('upd_stream').value
    };

    try {
        const res = await fetch(`http://localhost:3001/api/update/${id}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            const result = await res.json().catch(() => ({}));
            const successMsg = document.querySelector('#success-modal p');
            successMsg.innerText = "Student record updated successfully.";
            showSuccess('update');
            // Grade/stream changed here means the server reset this
            // student's section — flag it so the Registrar knows to run
            // the Placement Wizard for them, instead of finding out later
            // when a section-scoped bulk action mysteriously skips them.
            if (result.section_cleared) {
                showAlert("Grade/stream changed — this student now awaits placement into a section via the Placement Wizard.", "success");
            }
        } else {
            const raw = await res.text().catch(() => "Unknown error");
            let message = raw;
            try { message = JSON.parse(raw).error || raw; } catch (_) { /* plain-text error body */ }
            showAlert("Update failed: " + message);
        }
    } catch (err) {
        console.error("Fetch Error:", err);
        showAlert("Could not connect to the server.");
    }
}

async function fetchForPromotion() {
    const id = document.getElementById('promo-id').value.trim();
    const btn = document.querySelector('button[data-action="fetchForPromotion"]');
    if (!id) return showAlert("Please enter a Student ID");

    btn.innerText = "Searching...";
    document.getElementById('promo-form').style.display = 'none';

    try {
        const res = await fetch(`http://localhost:3001/api/student/${id}`, { credentials: 'include' });
        if (!res.ok) throw new Error("Student not found.");

        const data = await res.json();
        const currentGrade = parseInt(data.class_level);

        if (isNaN(currentGrade)) throw new Error("Invalid grade level in database.");

        const eligRes = await fetch(`http://localhost:3001/api/registrar/promotion-eligibility/${id}`, { credentials: 'include' });
        const eligibility = eligRes.ok ? await eligRes.json() : null;
        window.currentEligibility = eligibility;

        document.getElementById('promo-form').style.display = 'block';
        document.getElementById('student-name-display').innerText = `${data.first_name} ${data.last_name}`;
        document.getElementById('current-grade').innerText = currentGrade;

        const eligBox = document.getElementById('promo-eligibility');
        if (eligibility) {
            const color = eligibility.category === 'Eligible for Promotion' ? '#27ae60'
                : eligibility.category === 'Detained/Retained' ? '#e74c3c' : '#7f8c8d';
            eligBox.innerHTML = `
                <p><strong>Year Average:</strong> ${eligibility.year_average ?? 'N/A'}
                   &nbsp;&nbsp;<strong>Cutoff:</strong> ${eligibility.cutoff_mark ?? 'Not set'}</p>
                <p><strong>Category:</strong> <span style="color:${color}; font-weight:bold;">${eligibility.category}</span></p>
            `;
        } else {
            eligBox.innerHTML = '<p class="muted">Could not evaluate eligibility.</p>';
        }

        const newGradeSelect = document.getElementById('new-grade');
        const streamContainer = document.getElementById('stream-select-container');
        const streamSelect = document.getElementById('stream-select');
        const promoteRadio = document.getElementById('action-promote');
        const retainRadio = document.getElementById('action-retain');

        newGradeSelect.innerHTML = '';
        promoteRadio.disabled = false;
        promoteRadio.checked = false;
        retainRadio.checked = false;
        document.getElementById('override-reason-box').style.display = 'none';
        document.getElementById('override-reason').value = '';

        // Reset the locked-outcome UI back to "not locked" before
        // deciding below — otherwise a leftover state from the
        // previous student's search would stick around.
        document.getElementById('promo-decision-choice').style.display = 'block';
        document.getElementById('promo-locked-outcome').style.display = 'none';
        document.getElementById('promote-fields').style.display = 'block';
        window.isLockedToCutoff = false;

        if (currentGrade >= 12) {
            newGradeSelect.innerHTML = '<option value="">No higher grade — graduation is handled separately</option>';
            promoteRadio.disabled = true;
            retainRadio.checked = true;
            streamContainer.style.display = 'none';
        } else {
            newGradeSelect.innerHTML = `<option value="${currentGrade + 1}">Grade ${currentGrade + 1}</option>`;

            // Stream (Natural/Social Science) is only chosen once, at the
            // Grade 10 to 11 transition — that's the actual streaming
            // point in this system. An 11 to 12 promotion keeps whatever
            // stream the student already has; asking again here (and the
            // server defaulting to 'General' if left blank) used to
            // silently overwrite it.
            if (currentGrade === 10) {
                streamContainer.style.display = 'block';
                streamSelect.innerHTML = `
                    <option value="Natural Science">Natural Science</option>
                    <option value="Social Science">Social Science</option>
                `;
            } else {
                streamContainer.style.display = 'none';
            }

            // Grades 9-11 are locked to the Academic VP's cutoff — the
            // server ignores whatever action is submitted and applies
            // the cutoff result automatically (PUT /api/promote/:id),
            // with no override path at all. So instead of letting the
            // Registrar pick Promote/Retain, hide that choice and show
            // the computed outcome as read-only. The stream picker
            // above still applies (a real choice the Registrar makes),
            // but only matters when the outcome is actually a promotion.
            window.isLockedToCutoff = true;
            document.getElementById('promo-decision-choice').style.display = 'none';
            const lockedBox = document.getElementById('promo-locked-outcome');
            const lockedText = document.getElementById('locked-outcome-text');
            lockedBox.style.display = 'block';

            if (eligibility && eligibility.category === 'Eligible for Promotion') {
                lockedText.innerHTML = `<span style="color:#27ae60; font-weight:bold;">Promote to Grade ${currentGrade + 1}</span>`;
                document.getElementById('promote-fields').style.display = 'block';
            } else if (eligibility && eligibility.category === 'Detained/Retained') {
                lockedText.innerHTML = `<span style="color:#e74c3c; font-weight:bold;">Retain in Grade ${currentGrade}</span>`;
                document.getElementById('promote-fields').style.display = 'none';
            } else {
                lockedText.innerHTML = `<span style="color:#7f8c8d; font-weight:bold;">No decision yet — no marks on record</span>`;
                document.getElementById('promote-fields').style.display = 'none';
            }
        }
        updateOverrideVisibility();
    } catch (error) {
        console.error("Promotion Error:", error);
        showAlert(error.message);
    } finally {
        btn.innerText = "Search";
    }
}

// Shows the override-reason field only when the chosen action disagrees
// with the auto-computed category — matches the server's own check, so
// nobody hits a surprise 400 after already filling out the form.
function updateOverrideVisibility() {
    const box = document.getElementById('override-reason-box');
    if (!box) return;
    // Grades 9-11 have no override at all (see fetchForPromotion) — the
    // box never applies there, regardless of what's checked.
    if (window.isLockedToCutoff) {
        box.style.display = 'none';
        return;
    }
    const action = document.querySelector('input[name="promo-action"]:checked')?.value;
    const elig = window.currentEligibility;
    const expected = elig && elig.category === 'Eligible for Promotion' ? 'promote'
        : elig && elig.category === 'Detained/Retained' ? 'retain' : null;
    box.style.display = (expected && action && action !== expected) ? 'block' : 'none';
}

// --- Re-admission (Promote & Stream → Re-admitted) ---
// A student who graduated or transferred out is blocked from logging in
// (see the login route) — this is the only way back in. Two-step, same
// shape as fetchForPromotion/submitPromotion above: look the ID up first
// (read-only, shows who they are and why they're eligible) before the
// separate confirm step actually reactivates the account.
async function lookupReadmit() {
    const id = document.getElementById('readmit-id').value.trim();
    const result = document.getElementById('readmit-result');
    if (!id) return showAlert("Please enter a Student ID");
    result.innerHTML = '<p class="muted">Searching...</p>';

    try {
        const res = await fetch(`http://localhost:3001/api/registrar/readmit/${id}`, { credentials: 'include' });
        const data = await res.json();
        if (!res.ok) {
            result.innerHTML = `<p class="muted">${data.error || "Could not find this student."}</p>`;
            return;
        }
        result.innerHTML = `
            <div class="search-box" style="flex-direction: column; align-items: flex-start;">
                <p style="margin: 0 0 6px;"><strong>${data.full_name}</strong> (${data.student_id})</p>
                <p class="muted" style="margin: 0 0 12px;">
                    Last grade: ${data.class_level} &nbsp;•&nbsp; Status: ${data.status}
                </p>
                <button type="button" data-action="confirmReadmit" data-arg="${data.student_id}">
                    <span data-i18n="reg_readmit_confirm_btn">Re-admit This Student</span>
                </button>
            </div>
        `;
        if (window.lucide) lucide.createIcons({ root: result });
    } catch (err) {
        console.error(err);
        result.innerHTML = `<p class="muted">${t("reg_server_error")}</p>`;
    }
}

async function confirmReadmit(studentId) {
    const id = studentId || document.getElementById('readmit-id').value.trim();
    if (!id) return;
    if (!(await showConfirm(
        `Re-admit ${id}? Their account unlocks again with the default password, and they'll need to be placed into a current section from the Placement Wizard.`
    ))) return;

    try {
        const res = await fetch(`http://localhost:3001/api/registrar/readmit/${id}`, {
            method: 'POST',
            credentials: 'include'
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Could not re-admit this student.");
        showAlert(result.message);
        document.getElementById('readmit-id').value = '';
        document.getElementById('readmit-result').innerHTML = '';
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

async function autoProcessPromotion() {
    if (!(await showConfirm(
        "Auto-promote every eligible Grade 9 and Grade 11 student now? " +
        "Students below the cutoff are automatically retained instead — " +
        "this can't be undone from here."
    ))) return;

    try {
        const res = await fetch('http://localhost:3001/api/registrar/promotion/auto-process', {
            method: 'POST',
            credentials: 'include'
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Automatic promotion failed.");

        let summary = result.message;
        if (result.skipped && result.skipped.length > 0) {
            summary += `\n\nStill need marks entered:\n` + result.skipped.map(s => s.student_id).join(', ');
        }
        showAlert(summary);
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

async function submitPromotion() {
    const id = document.getElementById('promo-id').value;

    let action;
    if (window.isLockedToCutoff) {
        // Grades 9-11: nothing for the Registrar to choose — the action
        // is whatever the cutoff computed. The server re-derives and
        // enforces this itself either way (PUT /api/promote/:id ignores
        // whatever action is submitted for these grades), but deriving
        // it here too means the right fields (new grade/stream) get
        // sent, and lets us block the click when there's nothing to
        // decide yet rather than waiting on a server error.
        const elig = window.currentEligibility;
        action = elig && elig.category === 'Eligible for Promotion' ? 'promote'
            : elig && elig.category === 'Detained/Retained' ? 'retain' : null;
        if (!action) return showAlert("This student has no marks on record yet — a decision can't be made until they do.");
    } else {
        action = document.querySelector('input[name="promo-action"]:checked')?.value;
        if (!action) return showAlert("Choose Promote or Retain.");
    }

    const streamPickerShown = document.getElementById('stream-select-container').style.display !== 'none';
    const data = {
        action,
        class_level: action === 'promote' ? document.getElementById('new-grade').value : undefined,
        stream: (action === 'promote' && streamPickerShown) ? document.getElementById('stream-select').value : undefined,
        // No override is possible for grades 9-11 (see fetchForPromotion) —
        // the server ignores it for those anyway, but don't even send it.
        override_reason: window.isLockedToCutoff ? undefined : (document.getElementById('override-reason').value.trim() || undefined)
    };

    try {
        const res = await fetch(`http://localhost:3001/api/promote/${id}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();

        if (res.ok) {
            showAlert(result.message);
            resetPromotionForNextStudent();
        } else {
            showAlert(result.error || "Promotion failed.");
        }
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

// Clears the Promotion/Stream form back to its just-opened state so the
// Registrar can immediately search for the next student, without a full
// page reload (which used to kick them back to the Dashboard tab).
function resetPromotionForNextStudent() {
    document.getElementById('promo-id').value = '';
    document.getElementById('promo-form').style.display = 'none';
    document.getElementById('action-promote').checked = false;
    document.getElementById('action-retain').checked = false;
    document.getElementById('override-reason-box').style.display = 'none';
    document.getElementById('override-reason').value = '';
    document.getElementById('promo-decision-choice').style.display = 'block';
    document.getElementById('promo-locked-outcome').style.display = 'none';
    window.currentEligibility = null;
    window.isLockedToCutoff = false;
    // The Placement Wizard's "recently promoted" list is stale now too —
    // refresh it if that function is loaded, so the freshly-promoted
    // student shows up there without the Registrar switching tabs.
    if (typeof loadPlacementPromoted === 'function') loadPlacementPromoted();
    document.getElementById('promo-id').focus();
}

// Which form triggered the success modal — set right before showSuccess()
// so closeSuccess() knows what "ready for another one" means without
// having to guess from whatever tab happens to be active.
let successModalContext = null;

function showSuccess(context) {
    successModalContext = context || null;
    document.getElementById('success-modal').style.display = 'block';
}

// Used to just location.reload() the whole page here, which is why
// finishing a registration or an update dumped the Registrar back on
// the Dashboard instead of leaving them on the same form ready to do
// another one — a real workflow problem when they're working through
// a stack of new students or updates back-to-back. Now it just clears/
// refocuses the form that was actually submitted and leaves the tab
// exactly where it was.
function closeSuccess() {
    document.getElementById('success-modal').style.display = 'none';
    if (successModalContext === 'registration') {
        // The form itself was already reset right after the successful
        // POST (see submitRegistration) — just get the cursor back to
        // the first field for the next student.
        document.getElementById('reg_first')?.focus();
    } else if (successModalContext === 'update') {
        document.getElementById('update-form')?.reset();
        document.getElementById('upd_id').value = '';
        document.getElementById('search-id').value = '';
        document.getElementById('search-id')?.focus();
    }
    successModalContext = null;
}

// --- 4. Recorder Management (Registrar only) ---

async function loadRecorders() {
    const listEl = document.getElementById('current-recorders-list');
    try {
        const res = await fetch('http://localhost:3001/api/registrar/recorders', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load recorders.");
        const { recorders } = await res.json();

        if (recorders.length === 0) {
            listEl.innerHTML = '<p class="muted">No recorders assigned yet.</p>';
            return;
        }

        listEl.innerHTML = recorders.map(r => `
            <div class="search-box" style="justify-content: space-between; align-items:center;">
                <span>${r.first_name} ${r.middle_name || ''} ${r.last_name} (${r.teacher_id})</span>
                <button type="button" ${dataArg('removeRecorder', r.teacher_id)} style="background:#e74c3c;">Remove</button>
            </div>
        `).join('');

        // Only 2 active recorders allowed — hide the "add" box once full.
        document.getElementById('add-recorder-box').style.display = recorders.length >= 2 ? 'none' : 'block';
    } catch (err) {
        console.error(err);
        listEl.innerHTML = '<p class="muted">Could not load recorders.</p>';
    }
}

async function loadEligibleTeachers() {
    const select = document.getElementById('eligible-teacher-select');
    try {
        const res = await fetch('http://localhost:3001/api/registrar/eligible-recorders', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load eligible teachers.");
        const teachers = await res.json();

        if (teachers.length === 0) {
            select.innerHTML = '<option value="">No eligible teachers</option>';
            return;
        }
        select.innerHTML = teachers.map(t =>
            `<option value="${t.teacher_id}">${t.first_name} ${t.middle_name || ''} ${t.last_name} (${t.teacher_id})</option>`
        ).join('');
    } catch (err) {
        console.error(err);
        select.innerHTML = '<option value="">Could not load teachers</option>';
    }
}

async function assignRecorder() {
    const select = document.getElementById('eligible-teacher-select');
    const teacher_id = select.value;
    if (!teacher_id) return showAlert("Choose a teacher first.");

    try {
        const res = await fetch('http://localhost:3001/api/registrar/recorders', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id })
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Could not assign recorder.");

        await loadRecorders();
        await loadEligibleTeachers();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

async function removeRecorder(teacher_id) {
    if (!(await showConfirm(t('reg_remove_recorder_confirm')))) return;
    try {
        const res = await fetch(`http://localhost:3001/api/registrar/recorders/${teacher_id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Could not remove recorder.");

        await loadRecorders();
        await loadEligibleTeachers();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

// --- 5. Section Setup (Registrar only) ---

function updateSectionSetupStreamOptions() {
    const grade = document.getElementById('sec_grade').value;
    const streamSelect = document.getElementById('sec_stream');
    streamSelect.innerHTML = '';
    if (grade == '9' || grade == '10') {
        streamSelect.innerHTML = '<option value="General">General</option>';
    } else if (grade == '11' || grade == '12') {
        streamSelect.innerHTML = `
            <option value="Natural Science">Natural Science</option>
            <option value="Social Science">Social Science</option>
        `;
    } else {
        streamSelect.innerHTML = '<option value="">Select Stream</option>';
    }
}

async function loadSections() {
    const container = document.getElementById('sections-list');
    if (!container) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/sections', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load sections.");
        const sections = await res.json();

        if (sections.length === 0) {
            container.innerHTML = '<p class="muted">No sections configured yet.</p>';
            return;
        }

        // Group by class_level + stream so the panel reads like the rest
        // of the app (Grade 9, Grade 11 - Natural Science, etc.).
        const groups = {};
        sections.forEach(s => {
            const key = `Grade ${s.class_level} - ${s.stream}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(s);
        });

        container.innerHTML = Object.entries(groups).map(([label, rows]) => `
            <h4 style="margin-bottom:8px;">${label}</h4>
            ${rows.map(s => `
                <div class="search-box" style="justify-content: space-between; align-items:center; flex-wrap:wrap;">
                    <span><strong>${s.section_name}</strong></span>
                    <span class="section-capacity-box">
                        <label for="sec-cap-${s.id}">Max students</label>
                        <input
                            type="number"
                            id="sec-cap-${s.id}"
                            min="1"
                            value="${s.max_capacity ?? ''}"
                            placeholder="No limit"
                        />
                        <button type="button" ${dataArgs('updateSectionCapacity', [s.id, `sec-cap-${s.id}`])}>
                            <i data-lucide="save" aria-hidden="true" style="width:14px; height:14px;"></i>
                            Update
                        </button>
                    </span>
                    <span style="display:flex; align-items:center; gap:10px;">
                        <label style="font-weight:normal; margin:0;">
                            <input type="checkbox" ${s.is_active ? 'checked' : ''} ${dataOnchangeChecked('toggleSectionActive', s.id)} />
                            Active
                        </label>
                        <button type="button" ${dataArg('deleteSection', s.id)} style="background:#e74c3c;">Delete</button>
                    </span>
                </div>
            `).join('')}
        `).join('');
        window.refreshIcons();
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load sections.</p>';
    }
}

// Populates the Documents tab's "Bulk Documents" section picker from
// the same active sections used in Section Setup, so there's one
// source of truth for what a "section" is. Each option now shows its
// live student_count (from /api/registrar/sections) so a Registrar
// can see a section is empty before picking it, rather than only
// finding out after the bulk download comes back with nothing.
async function loadBulkSectionOptions() {
    const select = document.getElementById('bulk-doc-section');
    if (!select) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/sections', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load sections.");
        const sections = await res.json();
        const active = sections.filter(s => s.is_active);
        select.innerHTML = active.length === 0
            ? '<option value="">No active sections configured</option>'
            : '<option value="">Select a section…</option>' + active
                .map(s => {
                    const count = s.student_count || 0;
                    const label = `Grade ${s.class_level} — ${s.section_name} (${s.stream}) — ${count} student${count === 1 ? '' : 's'}`;
                    return `<option value="${s.class_level}|${s.section_name}|${s.stream}" ${count === 0 ? 'disabled' : ''}>${label}${count === 0 ? ' — empty' : ''}</option>`;
                })
                .join('');
    } catch (err) {
        console.error(err);
        select.innerHTML = '<option value="">Could not load sections</option>';
    }
}

// window.open()-ing these endpoints directly used to mean a 404 ("no
// students in that grade/section/stream") just dumped raw JSON into a
// blank new tab — easy to mistake for the download silently failing.
// Fetching first lets a failed request show a normal toast instead, and
// only opens/downloads a new tab once there's an actual file to show.
async function downloadBulkDocument(url, fallbackFilename) {
    try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
            const body = await res.json().catch(() => null);
            if (body?.pending_placement) {
                // These students exist but haven't been seated into a
                // section yet (fresh promotion / info update) — point
                // straight at the Placement Wizard instead of leaving
                // the registrar to guess why the bulk export came back
                // empty.
                showAlert(body.error, "error");
                if (confirm(`${body.error}\n\nOpen the Placement Wizard now?`)) {
                    switchTab('placement-wizard');
                }
                return;
            }
            showAlert(body?.error || "Could not generate that document.", "error");
            return;
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="?([^"]+)"?/);
        const filename = match ? match[1] : fallbackFilename;

        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(blobUrl);
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

function bulkDownloadIdCards() {
    const val = document.getElementById('bulk-doc-section')?.value;
    if (!val) { showAlert("Pick a section first.", "error"); return; }
    const [class_level, section, stream] = val.split('|');
    const params = new URLSearchParams({ class_level, section, stream });
    downloadBulkDocument(`http://localhost:3001/api/registrar/documents/id-card/bulk/pdf-zip?${params}`, `ID-Cards-Grade${class_level}-${section}.zip`);
}

function bulkDownloadReportCards() {
    const val = document.getElementById('bulk-doc-section')?.value;
    if (!val) { showAlert("Pick a section first.", "error"); return; }
    const [class_level, section, stream] = val.split('|');
    const params = new URLSearchParams({ class_level, section, stream });
    downloadBulkDocument(`http://localhost:3001/api/registrar/documents/report-card/bulk/pdf?${params}`, `ReportCards-Grade${class_level}-${section}.pdf`);
}

async function addSection() {
    const class_level = document.getElementById('sec_grade').value;
    const stream = document.getElementById('sec_stream').value;
    const section_name = document.getElementById('sec_name').value.trim();
    const max_capacity = document.getElementById('sec_capacity').value.trim();

    if (!class_level || !stream || !section_name) return showAlert("Grade, stream, and section name are required.");

    try {
        const res = await fetch('http://localhost:3001/api/registrar/sections', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ class_level, stream, section_name, max_capacity: max_capacity || null })
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Could not create section.");

        document.getElementById('sec_name').value = '';
        document.getElementById('sec_capacity').value = '';
        await loadSections();
        loadBulkSectionOptions();
        await loadUnassignedQueue();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

async function toggleSectionActive(id, isActive) {
    try {
        const res = await fetch(`http://localhost:3001/api/registrar/sections/${id}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: isActive })
        });
        if (!res.ok) {
            const result = await res.json();
            showAlert(result.error || "Could not update section.");
            await loadSections();
        loadBulkSectionOptions();
            return;
        }
        await loadUnassignedQueue();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

// Lets a section's max_capacity be raised (or lowered/cleared) in
// place — e.g. once a section is already fully set up and just needs
// room for a couple more students, there's no need to delete it and
// set it back up from scratch. Existing students already placed there
// aren't affected either way; this only changes how many MORE the
// Placement Wizard is willing to seat into it. Requires re-entering the
// Registrar's own password first — same step-up confirmation pattern
// used before starting/cancelling a transfer — since raising a class's
// size is a real capacity decision, not a cosmetic edit.
async function updateSectionCapacity(id, inputId) {
    const input = document.getElementById(inputId);
    const raw = input ? input.value.trim() : '';
    if (raw && (isNaN(raw) || Number(raw) < 1)) {
        return showAlert("Enter a valid capacity, or leave it blank for no limit.");
    }
    const password = await showPasswordPrompt(t('reg_section_capacity_password_prompt'));
    if (password === null) return;
    if (!password) return showAlert("Enter your password to continue.", "error");

    try {
        const res = await fetch(`http://localhost:3001/api/registrar/sections/${id}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ max_capacity: raw ? Number(raw) : null, password })
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Could not update capacity.");
        showAlert("Section capacity updated.", "success");
        await loadSections();
        loadBulkSectionOptions();
        await loadUnassignedQueue();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

async function deleteSection(id) {
    if (!(await showConfirm(t('reg_delete_section_confirm')))) return;
    try {
        const res = await fetch(`http://localhost:3001/api/registrar/sections/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Could not delete section.");
        await loadSections();
        loadBulkSectionOptions();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

// --- 6. Automated Section Placement Wizard (Registrar only) ---

// "Registered so far" — every student currently sitting unassigned,
// whether they arrived via New Entry Registration or a completed
// transfer, each labeled with when they enrolled. containerId defaults
// to the Placement Wizard tab's own list, but the New Entry Registration
// "View Registered So Far" button (see viewRegisteredQueue below) points
// this at the queue-view modal instead.
async function loadPlacementRegistered(containerId = 'placement-registered-list') {
    const container = document.getElementById(containerId);
    if (!container) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/placement/registered', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load registered students.");
        const students = await res.json();
        if (students.length === 0) {
            container.innerHTML = `<p class="muted">${t('reg_no_registered')}</p>`;
            return;
        }
        container.innerHTML = students.map(s => `
            <div class="search-box" style="justify-content: space-between; align-items: center;">
                <span><strong>${s.full_name}</strong> <span class="muted">(${s.student_id})</span> &nbsp; ${t('reg_grade_label')} ${s.class_level} — ${s.stream}</span>
                <span class="muted" style="font-size: 12px;">${t('reg_enrolled_label')}: ${formatYearBilingual(s.created_at) || '—'}</span>
            </div>
        `).join('');
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load registered students.</p>';
    }
}

// "Promoted students" — recent grade-ups (last 90 days), shown here
// since a fresh promotion batch is usually exactly why a Registrar
// opens the Placement Wizard next. containerId defaults to the
// Placement Wizard tab's own list, but Promotion/Stream's "View
// Promoted So Far" button (see viewPromotedQueue below) points this at
// the queue-view modal instead.
async function loadPlacementPromoted(containerId = 'placement-promoted-list') {
    const container = document.getElementById(containerId);
    if (!container) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/placement/promoted', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load promoted students.");
        const rows = await res.json();
        if (rows.length === 0) {
            container.innerHTML = `<p class="muted">${t('reg_no_promoted')}</p>`;
            return;
        }
        container.innerHTML = rows.map(r => `
            <div class="search-box" style="justify-content: space-between; align-items: center;">
                <span><strong>${r.full_name}</strong> <span class="muted">(${r.student_id})</span> &nbsp; ${t('reg_grade_label')} ${r.from_class_level} → ${r.to_class_level}${r.section ? ' - ' + r.section : ''}</span>
                <span class="muted" style="font-size: 12px;">${formatDateBilingual(r.decided_at)}</span>
            </div>
        `).join('');
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load promoted students.</p>';
    }
}

async function loadUnassignedQueue() {
    const container = document.getElementById('placement-queue');
    if (!container) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/unassigned-queue', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load the unassigned queue.");
        const { buckets, total_unassigned } = await res.json();

        document.getElementById('placement-total').innerText = total_unassigned;

        if (buckets.length === 0) {
            container.innerHTML = '<p class="muted">No students waiting for placement.</p>';
            return;
        }

        container.innerHTML = buckets.map(b => `
            <div class="search-box" style="flex-direction:column; align-items:stretch;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span><strong>Grade ${b.class_level} - ${b.stream}</strong> — ${b.students.length} waiting</span>
                    <button type="button" ${dataArgs('runPlacement', [b.class_level, b.stream])}
                        ${b.active_sections_configured === 0 ? 'disabled title="No active sections configured for this grade/stream"' : ''}>
                        Run Placement
                    </button>
                </div>
                ${b.active_sections_configured === 0
                    ? '<p class="muted" style="margin:8px 0 0;">No active sections configured for this grade/stream yet — set one up above first.</p>'
                    : ''}
            </div>
        `).join('');
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load the unassigned queue.</p>';
    }
}

// --- 6b. "View" preview modal for New Entry Registration / Promotion ---
// Lets a Registrar glance at who they've registered/promoted so far
// right from those tabs, without having to switch to the Placement
// Wizard first — then jump straight there via the modal's own button
// once they're ready to actually seat those students into sections.
// Reuses loadPlacementRegistered/loadPlacementPromoted against the
// modal's own list container (see the containerId param added above)
// rather than duplicating that rendering logic.
function openQueueViewModal(headingKey) {
    const modal = document.getElementById('queue-view-modal');
    if (!modal) return;
    const heading = document.getElementById('queue-view-heading');
    if (heading) heading.setAttribute('data-i18n', headingKey);
    applyTranslations();
    modal.style.display = 'flex';
    if (window.lucide) lucide.createIcons({ root: modal });
}

function viewRegisteredQueue() {
    openQueueViewModal('reg_placement_registered_heading');
    loadPlacementRegistered('queue-view-list');
}

function viewPromotedQueue() {
    openQueueViewModal('reg_placement_promoted_heading');
    loadPlacementPromoted('queue-view-list');
}

function closeQueueViewModal() {
    const modal = document.getElementById('queue-view-modal');
    if (modal) modal.style.display = 'none';
}

function goToPlacementWizardFromModal() {
    closeQueueViewModal();
    switchTab('placement-wizard');
}

async function runPlacement(class_level, stream) {
    try {
        const res = await fetch('http://localhost:3001/api/registrar/trigger-placement', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ class_level, stream })
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Placement failed.");

        let summary = result.message;
        if (result.shortfall && result.shortfall.length > 0) {
            summary += `\n${result.shortfall.length} student(s) couldn't be placed — all active sections are full.`;
        }
        showAlert(summary);

        await loadUnassignedQueue();
        await loadSections();
        loadBulkSectionOptions();
        await loadPlacementRegistered();
        await loadStudentRegistry();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

async function runPlacementAll() {
    try {
        const res = await fetch('http://localhost:3001/api/registrar/trigger-placement', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Placement failed.");

        let summary = result.message;
        if (result.skipped_buckets && result.skipped_buckets.length > 0) {
            summary += `\n${result.skipped_buckets.length} grade/stream group(s) skipped — no active sections configured.`;
        }
        if (result.shortfall && result.shortfall.length > 0) {
            summary += `\n${result.shortfall.length} student(s) couldn't be placed — all active sections are full.`;
        }
        showAlert(summary);

        await loadUnassignedQueue();
        await loadSections();
        loadBulkSectionOptions();
        await loadPlacementRegistered();
        await loadStudentRegistry();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}
// --- 6b. Student Registry ("Students" nav) ---
// Every student who's ever been enrolled here, each labeled with when
// they enrolled and — once they've graduated or transferred out — when
// they left, both in E.C. with the Gregorian date in brackets.

function statusPillClass(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'active') return 'status-active';
    if (s === 'pending promotion') return 'status-pending';
    if (s === 'inactive') return 'status-inactive';
    if (s === 'unregistered') return 'status-unregistered';
    if (s === 'graduated') return 'status-graduated';
    if (s.startsWith('transferred - pending')) return 'status-transferring';
    if (s.startsWith('transferred')) return 'status-transferred';
    return '';
}

// Populates the Academic Year filter dropdown on the Student Registry —
// the current year plus every past year a Semester-2 closure has ever
// rolled over into (see rolloverAcademicYear server-side). Called once
// on load and again after a language switch.
async function loadAcademicYearOptions() {
    const select = document.getElementById('student_registry_academic_year');
    if (!select) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/academic-years', { credentials: 'include' });
        if (!res.ok) throw new Error('Could not load academic years');
        const years = await res.json();
        const prevValue = select.value;
        select.innerHTML = years.map(y =>
            `<option value="${y.is_current ? '' : y.id}">${escAttr(y.label)}${y.is_current ? ' (Current)' : ''}</option>`
        ).join('');
        select.value = prevValue || '';
    } catch (err) {
        console.error(err);
        select.innerHTML = '<option value="">Current Year</option>';
    }
}

async function exportStudentRegistryCsv() {
    const params = buildStudentRegistryParams();
    window.open(`http://localhost:3001/api/registrar/students/export.csv?${params.toString()}`, '_blank');
}

async function exportStudentRegistryPdf() {
    const params = buildStudentRegistryParams();
    window.open(`http://localhost:3001/api/registrar/students/export.pdf?${params.toString()}`, '_blank');
}

function buildStudentRegistryParams() {
    const statusFilter = document.getElementById('student_registry_status')?.value || '';
    const gradeFilter = document.getElementById('student_registry_grade')?.value || '';
    const q = document.getElementById('student_registry_search')?.value || '';
    const academicYearId = document.getElementById('student_registry_academic_year')?.value || '';

    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (gradeFilter) params.set('class_level', gradeFilter);
    if (q.trim()) params.set('q', q.trim());
    if (academicYearId) params.set('academic_year_id', academicYearId);
    return params;
}

async function loadStudentRegistry() {
    const container = document.getElementById('student-registry-list');
    if (!container) return;
    const params = buildStudentRegistryParams();

    try {
        const res = await fetch(`http://localhost:3001/api/registrar/students?${params.toString()}`, { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load the student registry.");
        const students = await res.json();
        if (students.length === 0) {
            container.innerHTML = '<p class="muted">No students match this filter.</p>';
            return;
        }
        container.innerHTML = `
            <div class="data-table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>${t('reg_col_student_id')}</th>
                            <th>${t('reg_col_name')}</th>
                            <th>${t('reg_col_grade')}</th>
                            <th>${t('reg_col_status')}</th>
                            <th>${t('reg_enrolled_label')}</th>
                            <th>${t('reg_left_label')}</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${students.map(s => `
                            <tr>
                                <td class="data-table-id">${s.student_id}</td>
                                <td>
                                    <button type="button" class="student-name-link" ${dataArg('viewStudentHistory', s.student_id)}>${s.full_name}</button>
                                </td>
                                <td>${t('reg_grade_label')} ${s.class_level}${s.section ? '-' + s.section : ''}${s.stream ? ' — ' + s.stream : ''}</td>
                                <td><span class="status-pill ${statusPillClass(s.status)}">${s.status || '—'}</span></td>
                                <td class="data-table-meta">${formatYearBilingual(s.enrolled_at) || '—'}</td>
                                <td class="data-table-meta">${s.left_at ? formatYearBilingual(s.left_at) : '—'}</td>
                                <td class="data-table-action">
                                    <button type="button" ${dataArg('viewStudentHistory', s.student_id)}>${t('reg_view_history')}</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load the student registry.</p>';
    }
}

// Shared by the Students tab and the Transfer Hub's incoming-code
// preview — same {chain, grade_summary} shape from
// getStudentAcademicChain server-side either way.
function renderStudentHistoryHtml(history) {
    if (!history || !history.chain || history.chain.length === 0) {
        return '<p class="muted">No history on record.</p>';
    }
    const chainHtml = history.chain.map(stop => `
        <div style="border-left: 3px solid #3498db; padding: 6px 0 6px 12px; margin-bottom: 8px;">
            <strong>${stop.school_name || 'Unknown school'}</strong> — ${stop.student_id}
            <br><span class="muted" style="font-size: 12px;">
                ${t('reg_enrolled_label')}: ${formatYearBilingual(stop.entered_at) || '—'}
                ${stop.left_at ? ` &nbsp;|&nbsp; ${t('reg_left_label')}: ${formatYearBilingual(stop.left_at)}` : ''}
            </span>
        </div>
    `).join('');

    const gradeRows = (history.grade_summary || []).map(g => `
        <tr>
            <td style="padding:6px; border:1px solid #ddd;">${t('reg_grade_label')} ${g.class_level}</td>
            <td style="padding:6px; border:1px solid #ddd; text-align:center;">${g.has_academic_record ? t('reg_doc_history_has_record') : t('reg_doc_history_no_record')}</td>
            <td style="padding:6px; border:1px solid #ddd;">${
                g.documents && g.documents.length > 0
                    ? g.documents.map(d => `${d.doc_type} (${formatYearBilingual(d.issued_at) || '—'})`).join(', ')
                    : t('reg_doc_history_not_issued')
            }</td>
        </tr>
    `).join('');

    return `
        <h4 style="margin-top:15px;">${t('reg_transfer_history_heading')}</h4>
        ${chainHtml}
        <h4 style="margin-top:15px;">${t('reg_doc_history_heading')}</h4>
        <table style="width:100%; border-collapse:collapse;">
            <thead><tr style="background:#2c3e50; color:white;">
                <th style="padding:6px; text-align:left; border:1px solid #ddd;">${t('reg_grade_label')}</th>
                <th style="padding:6px; border:1px solid #ddd;">${t('reg_doc_history_has_record')} / ${t('reg_doc_history_no_record')}</th>
                <th style="padding:6px; text-align:left; border:1px solid #ddd;">${t('reg_issuance_log_heading')}</th>
            </tr></thead>
            <tbody>${gradeRows}</tbody>
        </table>
    `;
}

async function viewStudentHistory(student_id) {
    const modal = document.getElementById('student-history-modal');
    const body = document.getElementById('student-history-body');
    if (!modal || !body) return;
    body.innerHTML = '<p class="muted">Loading...</p>';
    modal.style.display = 'flex';
    try {
        const res = await fetch(`http://localhost:3001/api/registrar/students/${encodeURIComponent(student_id)}/history`, { credentials: 'include' });
        const result = await res.json();
        if (!res.ok) { body.innerHTML = `<p class="muted">${result.error || "Could not load history."}</p>`; return; }
        body.innerHTML = renderStudentHistoryHtml(result);
    } catch (err) {
        console.error(err);
        body.innerHTML = '<p class="muted">Server connection error.</p>';
    }
}

function closeStudentHistory() {
    const modal = document.getElementById('student-history-modal');
    if (modal) modal.style.display = 'none';
}

// --- 7. Transfer Navigation Hub (Registrar + Recorder) ---

function showTransferPane(which) {
    document.getElementById('transfer-outgoing-pane').style.display = which === 'outgoing' ? 'block' : 'none';
    document.getElementById('transfer-incoming-pane').style.display = which === 'incoming' ? 'block' : 'none';
}

async function startOutgoingTransfer(student_id) {
    if (!student_id) return;
    if (!(await showConfirm(t('reg_generate_code_confirm')))) return;
    const password = await showPasswordPrompt(t('reg_transfer_password_prompt'));
    if (password === null) return;
    if (!password) return showAlert("Enter your password to continue.", "error");

    try {
        const res = await fetch('http://localhost:3001/api/registrar/transfers/outgoing', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_id, password })
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Could not start the transfer.");

        document.getElementById('outgoing-code-result').innerHTML = `
            <div class="search-box" style="flex-direction: column; align-items: flex-start; background: #eafaf1; border-color: #27ae60;">
                <strong>Transfer Code — share this with the receiving school:</strong>
                <div style="font-size: 22px; font-weight: bold; letter-spacing: 1px; margin: 8px 0;">${result.transfer_code}</div>
            </div>
        `;
        await loadApprovedTransferRequests();
        await loadOutgoingTransfers();
        await loadRegistrarNotifications();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

// Drives the "Approved Transfers Waiting to Clear" list — the only way a
// Registrar can start an outgoing transfer now. No free-text student ID
// field: a student only shows up here once their Principal has approved
// (or directly initiated) the transfer, and the server enforces the same
// rule independently of this UI.
async function loadApprovedTransferRequests() {
    const container = document.getElementById('approved-transfer-requests-list');
    if (!container) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/transfer-requests/approved', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load approved transfer requests.");
        const requests = await res.json();

        if (requests.length === 0) {
            container.innerHTML = `<p class="muted">${t('reg_no_approved_requests')}</p>`;
            return;
        }

        container.innerHTML = requests.map(reqRow => `
            <div class="search-box" style="justify-content: space-between; align-items: center; flex-wrap: wrap;">
                <span>
                    <strong>${reqRow.full_name || reqRow.student_id}</strong>
                    <span class="muted">(${reqRow.student_id})</span>
                    ${reqRow.class_level ? ` &nbsp; ${t('reg_grade_label')} ${reqRow.class_level}${reqRow.section ? '-' + reqRow.section : ''}` : ''}
                    <span class="chip-principal">${t('reg_principal_initiated')}</span>
                    ${reqRow.reason ? `<br><span class="muted" style="font-size: 12px;">${reqRow.reason}</span>` : ''}
                    <br><span class="muted" style="font-size: 12px;">${formatDateBilingual(reqRow.decided_at)}</span>
                </span>
                <button type="button" ${dataArg('startOutgoingTransfer', reqRow.student_id)}>${t('reg_generate_code')}</button>
            </div>
        `).join('');
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load approved transfer requests.</p>';
    }
}

async function loadOutgoingTransfers() {
    const container = document.getElementById('outgoing-transfers-list');
    if (!container) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/transfers/outgoing', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load outgoing transfers.");
        const transfers = await res.json();

        if (transfers.length === 0) {
            container.innerHTML = '<p class="muted">No outgoing transfers yet.</p>';
            return;
        }

        container.innerHTML = transfers.map(row => `
            <div class="search-box" style="justify-content: space-between; align-items: center; flex-wrap: wrap;">
                <span>
                    <strong>${row.student_id}</strong> &nbsp; Code: ${row.transfer_code} &nbsp;
                    <span style="text-transform: capitalize;">${outgoingTransferStatusLabel(row.status)}</span>
                    ${row.principal_request_id ? `<span class="chip-principal">${t('reg_principal_initiated')}</span>` : ''}
                    ${row.new_student_id ? ` &rarr; ${row.new_student_id}` : ''}
                    <br><span class="muted" style="font-size: 12px;">${formatDateBilingual(row.initiated_at)}</span>
                </span>
                ${row.status === 'pending' ? `<button type="button" ${dataArg('cancelOutgoingTransfer', row.id)} style="background:#e74c3c;">Cancel</button>` : ''}
            </div>
        `).join('');
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load outgoing transfers.</p>';
    }
}

// The Registrar is the final step on the sending side — once they've
// generated the code, there's nothing left for THEM to do (the
// receiving school takes it from here). "Pending" reads like the
// Registrar still owes an action, so it's relabeled here without
// touching the underlying 'pending' status string other queries rely on.
function outgoingTransferStatusLabel(status) {
    if (status === 'pending') return t('reg_transfer_status_transferred');
    if (status === 'completed') return t('reg_transfer_status_completed');
    if (status === 'cancelled') return t('reg_transfer_status_cancelled');
    return status;
}

async function cancelOutgoingTransfer(id) {
    if (!(await showConfirm(t('reg_cancel_transfer_confirm')))) return;
    const password = await showPasswordPrompt(t('reg_transfer_password_prompt'));
    if (password === null) return;
    if (!password) return showAlert("Enter your password to continue.", "error");

    try {
        const res = await fetch(`http://localhost:3001/api/registrar/transfers/outgoing/${id}/cancel`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Could not cancel the transfer.");
        await loadOutgoingTransfers();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

async function lookupIncomingTransfer() {
    const transfer_code = document.getElementById('in_transfer_code').value.trim();
    if (!transfer_code) return showAlert("Enter a transfer code first.");
    const preview = document.getElementById('incoming-preview');

    try {
        const res = await fetch('http://localhost:3001/api/registrar/transfers/incoming/lookup', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transfer_code })
        });
        const result = await res.json();
        if (!res.ok) {
            preview.innerHTML = `<p class="muted">${result.error || "Could not find that transfer code."}</p>`;
            return;
        }

        const s = result.snapshot;
        preview.innerHTML = `
            <div class="search-box" style="flex-direction: column; align-items: flex-start;">
                <p><strong>${s.first_name} ${s.middle_name || ''} ${s.last_name}</strong></p>
                <p>Grade ${s.class_level} — ${s.stream} &nbsp; | &nbsp; ${s.sex}</p>
                <button type="button" ${dataArg('completeIncomingTransfer', result.transfer_code)}>Confirm Import</button>
                <div style="width:100%; margin-top:10px;">${renderStudentHistoryHtml(result.history)}</div>
            </div>
        `;
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

async function completeIncomingTransfer(transfer_code) {
    try {
        const res = await fetch('http://localhost:3001/api/registrar/transfers/incoming/complete', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transfer_code })
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Could not complete the transfer.");

        showAlert(result.message);
        document.getElementById('in_transfer_code').value = '';
        document.getElementById('incoming-preview').innerHTML = '';
        await loadIncomingTransfers();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

function toggleExternalTransferForm() {
    const form = document.getElementById('external-transfer-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

function updateExternalStreamOptions() {
    const grade = document.getElementById('ext_grade').value;
    const streamSelect = document.getElementById('ext_stream');
    streamSelect.innerHTML = '';
    if (grade == '9' || grade == '10') {
        streamSelect.innerHTML = '<option value="General">General</option>';
    } else if (grade == '11' || grade == '12') {
        streamSelect.innerHTML = `
            <option value="Natural Science">Natural Science</option>
            <option value="Social Science">Social Science</option>
        `;
    } else {
        streamSelect.innerHTML = '<option value="">Select Stream</option>';
    }
}

async function submitExternalTransfer() {
    const data = {
        first_name: document.getElementById('ext_first').value,
        middle_name: document.getElementById('ext_middle').value,
        last_name: document.getElementById('ext_last').value,
        sex: document.getElementById('ext_sex').value,
        class_level: document.getElementById('ext_grade').value,
        stream: document.getElementById('ext_stream').value,
        phone_number: document.getElementById('ext_phone').value,
        fayda_number: document.getElementById('ext_fayda').value
    };
    if (!data.first_name || !data.last_name || !data.sex || !data.class_level || !data.stream) {
        return showAlert("First name, last name, sex, grade, and stream are required.");
    }

    try {
        const res = await fetch('http://localhost:3001/api/registrar/transfers/incoming/manual', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Could not add this student.");

        showAlert(result.message);
        document.getElementById('external-transfer-form').style.display = 'none';
        ['ext_first', 'ext_middle', 'ext_last', 'ext_sex', 'ext_grade', 'ext_stream', 'ext_phone', 'ext_fayda'].forEach(id => {
            document.getElementById(id).value = '';
        });
        await loadIncomingTransfers();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

async function loadIncomingTransfers() {
    const container = document.getElementById('incoming-transfers-list');
    if (!container) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/transfers/incoming', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load incoming transfers.");
        const transfers = await res.json();

        if (transfers.length === 0) {
            container.innerHTML = '<p class="muted">No incoming transfers yet.</p>';
            return;
        }

        container.innerHTML = transfers.map(t => `
            <div class="search-box" style="justify-content: space-between; align-items: center;">
                <span>
                    <strong>${t.new_student_id}</strong>
                    ${t.is_external ? ' &mdash; External transfer' : ` &mdash; from network (was ${t.student_id})`}
                    <br><span class="muted" style="font-size: 12px;">${formatDateBilingual(t.completed_at)}</span>
                </span>
            </div>
        `).join('');
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load incoming transfers.</p>';
    }
}

// --- 8. Documents (Template Management Hub + Document Issuance Suite) ---

let currentDocStudentId = null;

async function loadDocumentStudent() {
    const student_id = document.getElementById('doc_student_id').value.trim();
    if (!student_id) return showAlert("Enter a Student ID first.");
    const info = document.getElementById('doc-student-info');
    const actions = document.getElementById('doc-student-actions');

    try {
        const res = await fetch(`http://localhost:3001/api/student/${encodeURIComponent(student_id)}`, { credentials: 'include' });
        const result = await res.json();
        if (!res.ok) {
            info.innerHTML = `<p class="muted">${result.error || "Student not found."}</p>`;
            actions.style.display = 'none';
            currentDocStudentId = null;
            return;
        }
        const fullName = [result.first_name, result.middle_name, result.last_name].filter(Boolean).join(' ');
        info.innerHTML = `<div class="search-box"><span><strong>${fullName}</strong> — Grade ${result.class_level}${result.section ? ' - ' + result.section : ' (Awaiting Placement)'}, ${result.stream}</span></div>`;
        currentDocStudentId = student_id;
        actions.style.display = 'flex';
        document.getElementById('doc-report-card-preview').innerHTML = '';
        await loadDocumentHistory(student_id);
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

// Grade 9-12 tracker: what's already on record, and what's already been
// issued — including from a school this student transferred in from, so
// the Registrar isn't re-issuing (or missing) something that already
// exists elsewhere on the platform.
async function loadDocumentHistory(student_id) {
    const container = document.getElementById('doc-grade-history');
    if (!container) return;
    container.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const res = await fetch(`http://localhost:3001/api/registrar/documents/history/${encodeURIComponent(student_id)}`, { credentials: 'include' });
        const result = await res.json();
        if (!res.ok) { container.innerHTML = `<p class="muted">${result.error || "Could not load history."}</p>`; return; }
        container.innerHTML = renderStudentHistoryHtml(result);
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load grade/document history.</p>';
    }
}

async function previewReportCard(student_id, targetId) {
    const preview = document.getElementById(targetId || 'doc-report-card-preview');
    preview.innerHTML = '<p class="muted">Loading...</p>';
    try {
        const res = await fetch(`http://localhost:3001/api/registrar/documents/report-card/${encodeURIComponent(student_id)}`, { credentials: 'include' });
        const result = await res.json();
        if (!res.ok) { preview.innerHTML = `<p class="muted">${result.error || "Could not load report card."}</p>`; return; }

        const fullName = [result.student.first_name, result.student.middle_name, result.student.last_name].filter(Boolean).join(' ');
        const sectionsHtml = result.report.length === 0
            ? '<p class="muted">No marks pushed for this student yet.</p>'
            : result.report.map(cl => `
                <h4>Grade ${cl.class_level} — ${cl.section} (${cl.stream})</h4>
                ${cl.subjects.length === 0 ? `
                <p class="muted" style="margin-bottom:15px;">No marks synced for Grade ${cl.class_level} yet — a report card can still be generated, but every subject will print blank.</p>
                ` : `
                <table style="width:100%; border-collapse:collapse; margin-bottom:15px;">
                    <thead><tr style="background:#2c3e50; color:white;">
                        <th style="padding:6px; text-align:left; border:1px solid #ddd;">Subject</th>
                        <th style="padding:6px; border:1px solid #ddd;">S1</th>
                        <th style="padding:6px; border:1px solid #ddd;">S2</th>
                        <th style="padding:6px; border:1px solid #ddd;">Year Avg</th>
                    </tr></thead>
                    <tbody>
                        ${cl.subjects.map(s => `<tr><td style="padding:6px; border:1px solid #ddd;">${s.subject_name}</td><td style="padding:6px; border:1px solid #ddd; text-align:center;">${s.semester_1 ?? '—'}</td><td style="padding:6px; border:1px solid #ddd; text-align:center;">${s.semester_2 ?? '—'}</td><td style="padding:6px; border:1px solid #ddd; text-align:center;">${s.year_average ?? '—'}</td></tr>`).join('')}
                    </tbody>
                </table>
                `}
            `).join('');

        // Lets the Registrar pick which grade's report card to actually
        // download/print — a student now in Grade 12 might only need
        // their Grade 9 record reissued, not their most recent one.
        // Includes the student's CURRENT grade even if no marks have
        // synced for it yet (see computeReportCardData), so a just-
        // promoted student's new grade is always an option here, not
        // just their last fully-synced one. Defaults to the highest
        // (most recent) grade, matching what downloadReportCard used to
        // always do before this existed.
        const selectId = `${targetId || 'doc-report-card-preview'}-grade-select`;
        const gradePickerHtml = result.report.length === 0 ? '' : `
                <div class="grade-download-picker">
                    <label for="${selectId}">Download grade:</label>
                    <select id="${selectId}">
                        ${result.report.map(cl => `<option value="${cl.class_level}">Grade ${cl.class_level}${cl.subjects.length === 0 ? ' (no marks yet)' : ''}</option>`).join('')}
                    </select>
                    <p class="muted">Pick any grade this student has a record for — not just their current one.</p>
                </div>`;

        preview.innerHTML = `
            <div style="border:1px solid #ddd; border-radius:8px; padding:20px; margin-top:15px; background:#f9f9f9;">
                <p><strong>${fullName}</strong> (${result.student.student_id})</p>
                ${sectionsHtml}
                ${gradePickerHtml}
                <button type="button" ${dataArgs('downloadReportCard', [student_id, selectId])}>Download PDF</button>
                <p class="muted" style="font-size:12px; margin-top:10px;">${formatDateBilingual(new Date())}</p>
            </div>
        `;
        // Default the picker to the most recent grade on file.
        if (result.report.length > 0) {
            const select = document.getElementById(selectId);
            if (select) select.value = result.report[result.report.length - 1].class_level;
        }
    } catch (err) {
        console.error(err);
        preview.innerHTML = '<p class="muted">Server connection error.</p>';
    }
}

function downloadReportCard(student_id, gradeSelectId) {
    const gradeSelect = gradeSelectId ? document.getElementById(gradeSelectId) : null;
    const classLevel = gradeSelect ? gradeSelect.value : '';
    const params = classLevel ? `?${new URLSearchParams({ class_level: classLevel })}` : '';
    window.open(`http://localhost:3001/api/registrar/documents/report-card/${encodeURIComponent(student_id)}/pdf${params}`, '_blank');
    setTimeout(loadIssuanceLog, 1500);
    setTimeout(() => loadDocumentHistory(student_id), 1500);
}

// Documents tab, real student — this both shows the transcript AND
// logs it as issued in one click (the PDF opens in a new tab since
// it's the actual issuance action, not just a look).
function previewTranscript(student_id) {
    window.open(`http://localhost:3001/api/registrar/documents/transcript/${encodeURIComponent(student_id)}/pdf`, '_blank');
    setTimeout(loadIssuanceLog, 1500);
    setTimeout(() => loadDocumentHistory(student_id), 1500);
}

// Templates tab sample — embedded in the page itself (an <iframe> into
// the same inline-disposition PDF endpoint) rather than opening
// anything, so it's a look, not a download or a new tab. Uses the real
// templates/certificate/certificate.html render (same as the actual
// issued report card), unlike the plain-table previewReportCard()
// used for a real student's quick in-page preview.
function previewSampleReportCard() {
    const preview = document.getElementById('doc-report-card-preview-templates');
    preview.innerHTML = `<iframe src="http://localhost:3001/api/registrar/documents/report-card/SAMPLE-0001/pdf" title="Sample Report Card" style="width:100%; height:80vh; min-height:600px; border:1px solid #ddd; border-radius:8px; margin-top:15px;"></iframe>`;
}

// Templates tab sample — embedded in the page itself (an <iframe> into
// the same inline-disposition PDF endpoint) rather than opening
// anything, so it's a look, not a download or a new tab.
function previewSampleTranscript() {
    const preview = document.getElementById('doc-report-card-preview-templates');
    preview.innerHTML = `<iframe src="http://localhost:3001/api/registrar/documents/transcript/SAMPLE-0001/pdf" title="Sample Transcript" style="width:100%; height:80vh; min-height:600px; border:1px solid #ddd; border-radius:8px; margin-top:15px;"></iframe>`;
}

// View-only ID card preview (HTML) — downloadIdCard() below is the
// actual PDF issuance, used from the Documents tab for a real student.
// Same front+back design as the student's own "My ID" tab — see
// buildIdCardHtml in server.js.
function downloadIdCard(student_id) {
    window.open(`http://localhost:3001/api/registrar/documents/id-card/${encodeURIComponent(student_id)}/pdf`, '_blank');
    setTimeout(loadIssuanceLog, 1500);
    setTimeout(() => loadDocumentHistory(student_id), 1500);
}

// Templates tab sample — embedded in the page via <iframe>, same
// pattern as previewSampleTranscript above.
function previewSampleIdCard() {
    const preview = document.getElementById('doc-report-card-preview-templates');
    preview.innerHTML = `<iframe src="http://localhost:3001/api/registrar/documents/id-card/SAMPLE-0001/preview" title="Sample ID Card" style="width:100%; height:70vh; min-height:560px; border:1px solid #ddd; border-radius:8px; margin-top:15px;"></iframe>`;
}

// The design is real and renders server-side from
// templates/recommendation.html — but there's no comment-capture
// feature yet to source real per-student data from, so only the
// sample ID has anything to show (the server returns a clear message
// for any other student_id rather than a fake letter).
function previewSampleRecommendation() {
    const preview = document.getElementById('doc-report-card-preview-templates');
    preview.innerHTML = `<iframe src="http://localhost:3001/api/registrar/documents/recommendation/SAMPLE-0001/preview" title="Sample Recommendation Letter" style="width:100%; height:80vh; min-height:600px; border:1px solid #ddd; border-radius:8px; margin-top:15px;"></iframe>`;
}

async function loadIssuanceLog() {
    const container = document.getElementById('issuance-log-list');
    if (!container) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/documents/issuance-log', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load issuance log.");
        const rows = await res.json();
        if (rows.length === 0) { container.innerHTML = '<p class="muted">No documents issued yet.</p>'; return; }

        const labels = { report_card: 'Report Card', transcript: 'Transcript', id_card: 'ID Card' };
        container.innerHTML = rows.map(r => `
            <div class="search-box" style="justify-content: space-between; align-items: center;">
                <span><strong>${r.student_id}</strong> &nbsp; ${labels[r.doc_type] || r.doc_type} &nbsp; Code: ${r.verify_code}</span>
                <span class="muted" style="font-size: 12px;">${formatDateBilingual(r.issued_at)}</span>
            </div>
        `).join('');
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load the issuance log.</p>';
    }
}

// --- 9. G12 Graduation Wizard ---

async function loadGraduationEligible() {
    const container = document.getElementById('graduation-eligible-list');
    if (!container) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/graduation/eligible', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load Grade 12 students.");
        const students = await res.json();
        if (students.length === 0) { container.innerHTML = '<p class="muted">No Grade 12 students waiting on graduation.</p>'; return; }

        container.innerHTML = `
            <div class="search-box" style="justify-content: flex-start; gap: 10px; background:#eef2f7;">
                <label style="font-weight: 600; display:flex; align-items:center; gap:10px;">
                    <input type="checkbox" id="grad-select-all" data-onchange-self="toggleSelectAllGraduates" />
                    <span>Select all (${students.length})</span>
                </label>
            </div>
        ` + students.map(s => {
            const fullName = [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ');
            const badge = s.category === 'Eligible for Promotion' ? 'color:#27ae60;' : s.category === 'Detained/Retained' ? 'color:#e74c3c;' : 'color:#7f8c8d;';
            return `
                <div class="search-box" style="justify-content: space-between; align-items: center;">
                    <label style="font-weight: normal; display:flex; align-items:center; gap:10px;">
                        <input type="checkbox" class="grad-checkbox" value="${s.student_id}" data-onchange="syncGradSelectAllState" />
                        <span><strong>${fullName}</strong> (${s.student_id}) — Avg: ${s.year_average ?? '—'}</span>
                    </label>
                    <span style="${badge} font-weight:600;">${s.category}</span>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load Grade 12 students.</p>';
    }
}

// Select-all checkbox above the graduation-eligible list: toggles every
// .grad-checkbox at once, and stays in sync if the person unchecks one
// student manually afterward.
function toggleSelectAllGraduates(selectAllBox) {
    document.querySelectorAll('.grad-checkbox').forEach(cb => { cb.checked = selectAllBox.checked; });
}
function syncGradSelectAllState() {
    const boxes = [...document.querySelectorAll('.grad-checkbox')];
    const selectAll = document.getElementById('grad-select-all');
    if (selectAll) selectAll.checked = boxes.length > 0 && boxes.every(cb => cb.checked);
}

async function processGraduation() {
    const checked = [...document.querySelectorAll('.grad-checkbox:checked')].map(cb => cb.value);
    const batch_tag = document.getElementById('grad_batch_tag').value.trim();
    const override_reason = document.getElementById('grad_override_reason').value.trim();

    if (checked.length === 0) return showAlert("Select at least one student.");
    if (!batch_tag) return showAlert('Enter a batch name (e.g. "Class of 2026").');

    // Graduating a batch locks every student in it out of their account
    // immediately, so — same as starting/cancelling a transfer — it
    // requires re-entering the registrar's own password right before it
    // happens, not just the earlier login session.
    const password = await showPasswordPrompt(t('reg_graduation_password_prompt'));
    if (password === null) return;
    if (!password) return showAlert("Enter your password to continue.", "error");

    try {
        const res = await fetch('http://localhost:3001/api/registrar/graduation/process', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_ids: checked, batch_tag, override_reason, password })
        });
        const result = await res.json();
        if (!res.ok) return showAlert(result.error || "Graduation processing failed.");

        let summary = result.message;
        if (result.skipped && result.skipped.length > 0) {
            summary += `\n\nSkipped:\n` + result.skipped.map(s => `${s.student_id}: ${s.reason}`).join('\n');
        }
        showAlert(summary);

        document.getElementById('grad_batch_tag').value = '';
        document.getElementById('grad_override_reason').value = '';
        await loadGraduationEligible();
        await loadGraduationHistory();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

async function loadGraduationHistory() {
    const container = document.getElementById('graduation-history-list');
    if (!container) return;
    try {
        const res = await fetch('http://localhost:3001/api/registrar/graduation/history', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load graduation history.");
        const rows = await res.json();
        if (rows.length === 0) { container.innerHTML = '<p class="muted">No graduations recorded yet.</p>'; return; }

        container.innerHTML = rows.map(r => {
            const fullName = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
            return `
                <div class="search-box" style="justify-content: space-between; align-items: center;">
                    <span><strong>${fullName}</strong> (${r.student_id}) — ${r.batch_tag}</span>
                    <span class="muted" style="font-size: 12px;">${formatDateBilingual(r.graduated_at)}</span>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load graduation history.</p>';
    }
}
// --- 10. Notification bell (document requests + transfer requests from
// the Principal) ---
// Mirrors the teacher portal's notification bell in script.js — same
// element IDs (notif-badge, notification-panel, notification-list) and
// same 60s-poll pattern, so it's a drop-in once the HTML markup below
// is added to the registrar page's top bar:
//
//   <div class="notification-wrapper">
//     <button class="notification-btn" aria-label="Notifications" onclick="toggleNotificationPanel()">
//       🔔<span id="notif-badge" class="notif-badge" style="display:none"></span>
//     </button>
//     <div id="notification-panel" class="notification-panel" style="display:none">
//       <div class="notification-panel-header"><strong>Notifications</strong></div>
//       <div id="notification-list"><p class="notif-empty">No new notifications</p></div>
//     </div>
//   </div>

async function loadRegistrarNotifications() {
    try {
        const res = await fetch('http://localhost:3001/api/registrar/notifications', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load notifications.");
        renderRegistrarNotifications(await res.json());
    } catch (err) {
        console.error("Notifications load error:", err);
    }
}

function renderRegistrarNotifications(items) {
    const badge = document.getElementById('notif-badge');
    const list = document.getElementById('notification-list');
    if (badge) badge.style.display = items.length > 0 ? 'inline-block' : 'none';
    if (badge) badge.textContent = items.length > 9 ? '9+' : String(items.length);

    if (list) {
        if (items.length === 0) {
            list.innerHTML = '<p class="notif-empty">No new notifications</p>';
        } else {
            list.innerHTML = items.map(item => `
                <div class="notif-item" ${dataArgs('handleRegistrarNotificationClick', [item.type, item.student_id])}>
                    <strong>${item.text}</strong>
                    <span class="muted" style="font-size:11px;">${formatDateBilingual(item.at)}</span>
                </div>
            `).join('');
        }
    }

    updateNavNotificationBadges(items);
}

// Mirrors the same "something's waiting for you" count onto the sidebar
// nav item each notification type resolves to (see
// handleRegistrarNotificationClick below for the same type -> tab
// mapping), so it's visible even with the bell panel closed.
function updateNavNotificationBadges(items) {
    const counts = {};
    items.forEach(item => { counts[item.type] = (counts[item.type] || 0) + 1; });

    const setBadge = (id, count) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (count > 0) {
            el.textContent = count > 9 ? '9+' : String(count);
            el.style.display = 'inline-block';
        } else {
            el.style.display = 'none';
        }
    };
    setBadge('nav-transfer-hub-badge', counts.transfer_request || 0);
    setBadge('nav-documents-badge', counts.document_request || 0);
}

// Clicking a notification jumps straight to the tab where it's actioned
// — the Documents tab for a document request, the Transfer Hub for a
// transfer ready to clear — rather than just closing the panel.
function handleRegistrarNotificationClick(type, student_id) {
    document.getElementById('notification-panel').style.display = 'none';
    if (type === 'document_request') {
        switchTab('documents');
        // NOTE: couldn't confirm the exact search-input ID on the
        // Documents tab (that markup lives in the registrar module's
        // index.html, which wasn't available) — wire this up to
        // prefill student_id once you send me that file.
    } else if (type === 'transfer_request') {
        switchTab('transfer-hub'); // NOTE: confirm this matches the actual tab-content id once you send the HTML
    }
}

window.toggleNotificationPanel = () => {
    const panel = document.getElementById('notification-panel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
};

document.addEventListener('click', (event) => {
    if (!event.target.closest('.notification-wrapper')) {
        const panel = document.getElementById('notification-panel');
        if (panel) panel.style.display = 'none';
    }
});

// --- 11. Sidebar/topbar chrome: per-tenant logo/school name, role
// badge, avatar — multi-tenant means none of this can be hardcoded in
// the HTML the way it used to be (e.g. the old static "Newland High
// School" text and /assets/images/Logo.png). Reads straight off
// /api/me, same fields the teacher portal's chrome already uses. The
// school logo itself is Principal-controlled (POST /api/school/logo on
// their side) — this just displays whatever they've set.
// Mirrors server.js's buildSchoolDisplayName exactly: "Newland" +
// "SECONDARY SCHOOL" -> "NEWLAND SECONDARY SCHOOL". school_level isn't
// implied by school_name alone (two schools can share a name at
// different levels), so the sidebar/topbar need both fields, not just
// school_name.
function buildSchoolDisplayName(schoolName, schoolLevel) {
    return [schoolName, schoolLevel].filter(Boolean).join(' ').toUpperCase() || '—';
}

function applyProfileChrome() {
    if (!currentUser) return;

    const displayName = buildSchoolDisplayName(currentUser.school_name, currentUser.school_level);

    const schoolName = document.getElementById('sidebar-school-name');
    if (schoolName) schoolName.textContent = displayName;

    // Note: #topbar-school-name no longer shows the school name (that's
    // covered by #sidebar-school-name in the sidebar header already). It
    // now shows whichever sidebar section is active — see
    // updateTopbarSectionName, called from switchTab and again below for
    // whichever tab is active at load time.
    const activeTab = document.querySelector('.tab-content.active');
    updateTopbarSectionName(activeTab ? activeTab.id : 'dashboard');

    const moeChip = document.getElementById('topbar-moe-code');
    if (moeChip) {
        if (currentUser.moe_school_code) {
            moeChip.textContent = `${t('reg_moe_code_label')}: ${currentUser.moe_school_code}`;
            moeChip.hidden = false;
        } else {
            moeChip.hidden = true;
        }
    }

    const roleBadge = document.getElementById('sidebar-role-badge');
    if (roleBadge) {
        roleBadge.textContent = currentUser.is_registrar ? 'Registrar' : currentUser.is_recorder ? 'Recorder' : '—';
    }

    const accountName = document.getElementById('topbar-account-name');
    if (accountName) {
        if (currentUser.admin_full_name) {
            accountName.textContent = currentUser.admin_full_name;
            accountName.hidden = false;
        } else {
            accountName.hidden = true;
        }
    }

    const avatar = document.getElementById('topbar-avatar');
    if (avatar) {
        if (currentUser.avatar_url) {
            avatar.src = currentUser.avatar_url;
            avatar.style.display = 'block';
        } else {
            avatar.style.display = 'none';
        }
    }

    loadCurrentSemesterChip();
}

// Current semester chip in the top bar — reads the same /api/term/current
// endpoint every logged-in page uses, so it always matches what Academic
// VP has actually declared open/closed (e.g. "Semester 1 — Open", or
// "Semester 1 — Closed" in red once they've closed it via POST
// /api/term/close). Also drops the current academic year — already
// formatted as "2018 E.C. (2025/26 GC)" by getCurrentAcademicYearLabel()
// server-side — into its own chip right next to it.
async function loadCurrentSemesterChip() {
    const chip = document.getElementById('topbar-semester');
    const yearChip = document.getElementById('topbar-academic-year');
    if (!chip && !yearChip) return;
    try {
        const res = await fetch('http://localhost:3001/api/term/current', { credentials: 'include' });
        if (!res.ok) throw new Error('Could not load current term.');
        const data = await res.json();

        if (chip) {
            const match = /\d+/.exec(data.current_term || '');
            if (match) {
                const isOpen = data.semester_status !== 'closed';
                chip.textContent = `${t('reg_semester_label', { n: match[0] })} — ${isOpen ? t('reg_status_open') : t('reg_status_closed')}`;
                chip.classList.remove('topbar-chip-accent', 'topbar-chip-open', 'topbar-chip-closed');
                chip.classList.add(isOpen ? 'topbar-chip-open' : 'topbar-chip-closed');
                chip.hidden = false;
            } else {
                chip.hidden = true;
            }
        }

        if (yearChip) {
            if (data.academic_year) {
                yearChip.textContent = data.academic_year;
                yearChip.hidden = false;
            } else {
                yearChip.hidden = true;
            }
        }

        updateGraduationWizardLock(data.current_term, data.semester_status);
    } catch (err) {
        console.error(err);
        if (chip) chip.hidden = true;
        if (yearChip) yearChip.hidden = true;
    }
}

// The Graduation Wizard only makes sense once Semester 2 is over — while
// hides the actionable part (the batch-tag/override/graduate button row
// plus the eligible-students list) behind a locked-banner explaining why,
// while leaving Graduation History visible underneath (read-only, so
// there's no harm in showing it early). Re-run every time
// loadCurrentSemesterChip() refreshes, so it un-hides itself the moment
// Academic VP closes Semester 2 without needing a page reload.
let semester2Closed = false;
function updateGraduationWizardLock(current_term, semester_status) {
    semester2Closed = current_term === 'Semester 2' && semester_status === 'closed';
    const banner = document.getElementById('graduation-locked-banner');
    const body = document.getElementById('graduation-wizard-body');
    if (banner) banner.style.display = semester2Closed ? 'none' : 'flex';
    if (body) body.style.display = semester2Closed ? '' : 'none';
}

// --- 12. Dashboard tab ---
async function loadDashboardStats() {
    try {
        const res = await fetch('http://localhost:3001/api/registrar/dashboard', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load dashboard stats.");
        const stats = await res.json();
        const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
        set('stat-total-students', stats.total_students);
        set('stat-male', stats.male);
        set('stat-female', stats.female);
        set('stat-total-transfers', stats.total_transfers);
    } catch (err) {
        console.error(err);
    }
}

// --- 13. Profile Settings modal: avatar + Registrar signature ---
// Registrar signature is deliberately its own upload, separate from any
// homeroom teacher signature (signature_url) — same account, but the
// two go on different documents. Both go through Principal approval,
// same as the homeroom teacher's own signature/ID-photo requests.
function openProfileSettings() {
    const modal = document.getElementById('profile-settings-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    const avatarPreview = document.getElementById('settings-avatar-preview');
    if (avatarPreview) avatarPreview.src = (currentUser && currentUser.avatar_url) || '';

    const avatarFilename = document.getElementById('settings-avatar-filename');
    if (avatarFilename) avatarFilename.textContent = t('reg_no_file_chosen');
    const signatureFilename = document.getElementById('settings-signature-filename');
    if (signatureFilename) signatureFilename.textContent = t('reg_no_file_chosen');

    loadRegistrarSignatureStatus();
}

function closeProfileSettings() {
    const modal = document.getElementById('profile-settings-modal');
    if (modal) modal.style.display = 'none';
}

async function loadRegistrarSignatureStatus() {
    const preview = document.getElementById('settings-signature-preview');
    const status = document.getElementById('settings-signature-status');
    if (!status) return;
    try {
        const res = await fetch('http://localhost:3001/api/teacher/document-status', { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load signature status.");
        const data = await res.json();
        if (data.registrar_signature_url && preview) {
            preview.src = data.registrar_signature_url;
            preview.style.display = 'block';
        }
        if (data.registrar_signature_request && data.registrar_signature_request.status === 'pending') {
            status.textContent = 'Pending Principal approval.';
        } else if (data.registrar_signature_url) {
            status.textContent = 'Approved and in use.';
        } else {
            status.textContent = 'No signature on file yet.';
        }
    } catch (err) {
        console.error(err);
        status.textContent = 'Could not load status.';
    }
}

async function uploadRegistrarAvatar(input) {
    if (!input.files || input.files.length === 0) return;
    const avatarFilename = document.getElementById('settings-avatar-filename');
    if (avatarFilename) avatarFilename.textContent = input.files[0].name;
    const formData = new FormData();
    formData.append('avatar', input.files[0]);
    try {
        const res = await fetch('http://localhost:3001/api/teacher/update-avatar', {
            method: 'POST', credentials: 'include', body: formData
        });
        const data = await res.json();
        if (!res.ok) return showAlert(data.error || "Could not upload profile picture.");
        if (currentUser) currentUser.avatar_url = data.new_avatar_url;
        applyProfileChrome();
        const preview = document.getElementById('settings-avatar-preview');
        if (preview) preview.src = data.new_avatar_url;
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

async function uploadRegistrarSignature(input) {
    if (!input.files || input.files.length === 0) return;
    const signatureFilename = document.getElementById('settings-signature-filename');
    if (signatureFilename) signatureFilename.textContent = input.files[0].name;
    const formData = new FormData();
    formData.append('signature', input.files[0]);
    try {
        const res = await fetch('http://localhost:3001/api/registrar/upload-signature', {
            method: 'POST', credentials: 'include', body: formData
        });
        const data = await res.json();
        if (!res.ok) return showAlert(data.error || "Could not submit signature.");
        showAlert(t('reg_signature_submitted'));
        loadRegistrarSignatureStatus();
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

// --- 14. Sidebar footer: Return to Portal + Logout ---
// NOTE: same uncertainty as closeRecorderIntercept() above — couldn't
// confirm the real teacher-portal entry route, so this uses the same
// placeholder path. Update both together if that route is different.
function returnToPortal() {
    window.location.href = '/teachers/index.html';
}

async function registrarLogout() {
    try {
        await fetch('http://localhost:3001/api/logout', { method: 'POST', credentials: 'include' });
    } catch (err) {
        console.error(err);
    }
    window.location.href = '/login.html';
}