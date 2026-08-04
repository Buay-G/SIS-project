// --- 0. Current User / Role Gating ---
// Registrar-only tabs: a Recorder can see these nav buttons but clicking
// them shows the security intercept instead of opening the tab.
// TODO: if the recorder/registrar split later covers more tabs (section
// setup, transfers, template hub, etc.), add their tab IDs here.
const REGISTRAR_ONLY_TABS = ['promotion', 'recorder-mgmt', 'section-setup', 'placement-wizard', 'documents', 'templates', 'graduation-wizard'];

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
document.addEventListener('DOMContentLoaded', () => {
    if (window.lucide) lucide.createIcons();
});

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
    const btn = document.querySelector('button[onclick="submitRegistration()"]');
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
            showSuccess(); 
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
            showSuccess(); 
        } else {
            const errorText = await res.text();
            showAlert("Update failed: " + errorText);
        }
    } catch (err) {
        console.error("Fetch Error:", err);
        showAlert("Could not connect to the server.");
    }
}

async function fetchForPromotion() {
    const id = document.getElementById('promo-id').value.trim();
    const btn = document.querySelector('button[onclick="fetchForPromotion()"]');
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

        if (currentGrade >= 12) {
            newGradeSelect.innerHTML = '<option value="">No higher grade — graduation is handled separately</option>';
            promoteRadio.disabled = true;
            retainRadio.checked = true;
            streamContainer.style.display = 'none';
        } else {
            newGradeSelect.innerHTML = `<option value="${currentGrade + 1}">Grade ${currentGrade + 1}</option>`;

            if (currentGrade === 10 || currentGrade === 11) {
                streamContainer.style.display = 'block';
                streamSelect.innerHTML = `
                    <option value="Natural Science">Natural Science</option>
                    <option value="Social Science">Social Science</option>
                `;
            } else {
                streamContainer.style.display = 'none';
            }

            // Pre-select whichever action the cutoff already suggests.
            if (eligibility && eligibility.category === 'Eligible for Promotion') promoteRadio.checked = true;
            else if (eligibility && eligibility.category === 'Detained/Retained') retainRadio.checked = true;
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
    const action = document.querySelector('input[name="promo-action"]:checked')?.value;
    const elig = window.currentEligibility;
    const box = document.getElementById('override-reason-box');
    if (!box) return;
    const expected = elig && elig.category === 'Eligible for Promotion' ? 'promote'
        : elig && elig.category === 'Detained/Retained' ? 'retain' : null;
    box.style.display = (expected && action && action !== expected) ? 'block' : 'none';
}

async function submitPromotion() {
    const id = document.getElementById('promo-id').value;
    const action = document.querySelector('input[name="promo-action"]:checked')?.value;
    if (!action) return showAlert("Choose Promote or Retain.");

    const data = {
        action,
        class_level: action === 'promote' ? document.getElementById('new-grade').value : undefined,
        stream: action === 'promote' ? (document.getElementById('stream-select').value || 'General') : undefined,
        override_reason: document.getElementById('override-reason').value.trim() || undefined
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
            location.reload();
        } else {
            showAlert(result.error || "Promotion failed.");
        }
    } catch (err) {
        console.error(err);
        showAlert(t("reg_server_error"));
    }
}

function showSuccess() {
    document.getElementById('success-modal').style.display = 'block';
}

function closeSuccess() {
    document.getElementById('success-modal').style.display = 'none';
    location.reload(); 
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
                <button type="button" onclick="removeRecorder('${r.teacher_id}')" style="background:#e74c3c;">Remove</button>
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
                <div class="search-box" style="justify-content: space-between; align-items:center;">
                    <span><strong>${s.section_name}</strong> ${s.max_capacity ? `(max ${s.max_capacity})` : '(no capacity limit)'}</span>
                    <span style="display:flex; align-items:center; gap:10px;">
                        <label style="font-weight:normal; margin:0;">
                            <input type="checkbox" ${s.is_active ? 'checked' : ''} onchange="toggleSectionActive(${s.id}, this.checked)" />
                            Active
                        </label>
                        <button type="button" onclick="deleteSection(${s.id})" style="background:#e74c3c;">Delete</button>
                    </span>
                </div>
            `).join('')}
        `).join('');
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load sections.</p>';
    }
}

// Populates the Documents tab's "Bulk Documents" section picker from
// the same active sections used in Section Setup, so there's one
// source of truth for what a "section" is.
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
                .map(s => `<option value="${s.class_level}|${s.section_name}|${s.stream}">Grade ${s.class_level} — ${s.section_name} (${s.stream})</option>`)
                .join('');
    } catch (err) {
        console.error(err);
        select.innerHTML = '<option value="">Could not load sections</option>';
    }
}

function bulkDownloadIdCards() {
    const val = document.getElementById('bulk-doc-section')?.value;
    if (!val) { showAlert("Pick a section first.", "error"); return; }
    const [class_level, section, stream] = val.split('|');
    const params = new URLSearchParams({ class_level, section, stream });
    window.open(`http://localhost:3001/api/registrar/documents/id-card/bulk/docx-zip?${params}`, '_blank');
}

function bulkDownloadReportCards() {
    const val = document.getElementById('bulk-doc-section')?.value;
    if (!val) { showAlert("Pick a section first.", "error"); return; }
    const [class_level, section, stream] = val.split('|');
    const params = new URLSearchParams({ class_level, section, stream });
    window.open(`http://localhost:3001/api/registrar/documents/report-card/bulk/pdf?${params}`, '_blank');
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
// transfer, each labeled with when they enrolled.
async function loadPlacementRegistered() {
    const container = document.getElementById('placement-registered-list');
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
// opens the Placement Wizard next.
async function loadPlacementPromoted() {
    const container = document.getElementById('placement-promoted-list');
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
                    <button type="button" onclick="runPlacement(${b.class_level}, '${b.stream}')"
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

async function loadStudentRegistry() {
    const container = document.getElementById('student-registry-list');
    if (!container) return;
    const statusFilter = document.getElementById('student_registry_status')?.value || '';
    const gradeFilter = document.getElementById('student_registry_grade')?.value || '';
    const q = document.getElementById('student_registry_search')?.value || '';

    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (gradeFilter) params.set('class_level', gradeFilter);
    if (q.trim()) params.set('q', q.trim());

    try {
        const res = await fetch(`http://localhost:3001/api/registrar/students?${params.toString()}`, { credentials: 'include' });
        if (!res.ok) throw new Error("Could not load the student registry.");
        const students = await res.json();
        if (students.length === 0) {
            container.innerHTML = '<p class="muted">No students match this filter.</p>';
            return;
        }
        container.innerHTML = students.map(s => `
            <div class="search-box" style="justify-content: space-between; align-items: center; flex-wrap: wrap;">
                <span>
                    <strong>${s.full_name}</strong> <span class="muted">(${s.student_id})</span>
                    &nbsp; ${t('reg_grade_label')} ${s.class_level}${s.section ? '-' + s.section : ''} — ${s.stream || ''}
                    <br>
                    <span class="muted" style="font-size: 12px;">
                        ${t('reg_enrolled_label')}: ${formatYearBilingual(s.enrolled_at) || '—'}
                        ${s.left_at ? ` &nbsp;|&nbsp; ${t('reg_left_label')}: ${formatYearBilingual(s.left_at)}` : ''}
                    </span>
                </span>
                <button type="button" onclick="viewStudentHistory('${s.student_id}')">${t('reg_view_history')}</button>
            </div>
        `).join('');
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

    try {
        const res = await fetch('http://localhost:3001/api/registrar/transfers/outgoing', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_id })
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
                <button type="button" onclick="startOutgoingTransfer('${reqRow.student_id}')">${t('reg_generate_code')}</button>
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
                ${row.status === 'pending' ? `<button type="button" onclick="cancelOutgoingTransfer(${row.id})" style="background:#e74c3c;">Cancel</button>` : ''}
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
    try {
        const res = await fetch(`http://localhost:3001/api/registrar/transfers/outgoing/${id}/cancel`, {
            method: 'POST',
            credentials: 'include'
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
                <button type="button" onclick="completeIncomingTransfer('${result.transfer_code}')">Confirm Import</button>
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
            `).join('');

        preview.innerHTML = `
            <div style="border:1px solid #ddd; border-radius:8px; padding:20px; margin-top:15px; background:#f9f9f9;">
                <p><strong>${fullName}</strong> (${result.student.student_id})</p>
                ${sectionsHtml}
                <button type="button" onclick="downloadReportCard('${student_id}')">Download PDF</button>
                <p class="muted" style="font-size:12px; margin-top:10px;">${formatDateBilingual(new Date())}</p>
            </div>
        `;
    } catch (err) {
        console.error(err);
        preview.innerHTML = '<p class="muted">Server connection error.</p>';
    }
}

function downloadReportCard(student_id) {
    window.open(`http://localhost:3001/api/registrar/documents/report-card/${encodeURIComponent(student_id)}/pdf`, '_blank');
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
// actual .docx issuance, used from the Documents tab for a real student.
function downloadIdCard(student_id) {
    window.open(`http://localhost:3001/api/registrar/documents/id-card/${encodeURIComponent(student_id)}/docx`, '_blank');
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
                    <input type="checkbox" id="grad-select-all" onchange="toggleSelectAllGraduates(this)" />
                    <span>Select all (${students.length})</span>
                </label>
            </div>
        ` + students.map(s => {
            const fullName = [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ');
            const badge = s.category === 'Eligible for Promotion' ? 'color:#27ae60;' : s.category === 'Detained/Retained' ? 'color:#e74c3c;' : 'color:#7f8c8d;';
            return `
                <div class="search-box" style="justify-content: space-between; align-items: center;">
                    <label style="font-weight: normal; display:flex; align-items:center; gap:10px;">
                        <input type="checkbox" class="grad-checkbox" value="${s.student_id}" onchange="syncGradSelectAllState()" />
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

    try {
        const res = await fetch('http://localhost:3001/api/registrar/graduation/process', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_ids: checked, batch_tag, override_reason })
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
                <div class="notif-item" onclick="handleRegistrarNotificationClick('${item.type}', '${item.student_id}')">
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
function applyProfileChrome() {
    if (!currentUser) return;

    const schoolName = document.getElementById('sidebar-school-name');
    if (schoolName) schoolName.textContent = currentUser.school_name || '—';

    const topbarSchoolName = document.getElementById('topbar-school-name');
    if (topbarSchoolName) {
        topbarSchoolName.textContent = currentUser.school_name || '—';
    }

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
// VP has actually declared open (e.g. "Semester 1").
async function loadCurrentSemesterChip() {
    const chip = document.getElementById('topbar-semester');
    if (!chip) return;
    try {
        const res = await fetch('http://localhost:3001/api/term/current', { credentials: 'include' });
        if (!res.ok) throw new Error('Could not load current term.');
        const data = await res.json();
        const match = /\d+/.exec(data.current_term || '');
        if (match) {
            chip.textContent = t('reg_semester_label', { n: match[0] });
            chip.hidden = false;
        } else {
            chip.hidden = true;
        }
    } catch (err) {
        console.error(err);
        chip.hidden = true;
    }
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