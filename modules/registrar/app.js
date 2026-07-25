// --- 0. Current User / Role Gating ---
// Registrar-only tabs: a Recorder can see these nav buttons but clicking
// them shows the security intercept instead of opening the tab.
// TODO: if the recorder/registrar split later covers more tabs (section
// setup, transfers, template hub, etc.), add their tab IDs here.
const REGISTRAR_ONLY_TABS = ['promotion', 'recorder-mgmt', 'section-setup', 'placement-wizard', 'documents', 'graduation-wizard'];

let currentUser = null;

async function loadCurrentUser() {
    try {
        const res = await fetch('http://localhost:3001/api/me', { credentials: 'include' });
        if (!res.ok) return;
        currentUser = await res.json();
        applyRolePermissions();
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

// Re-render whatever's currently loaded so dynamic (non-data-i18n) text —
// list items, dates, alerts built in JS — picks up the new language too.
// i18n.js calls this automatically after setLang() via window.onSisLangChange.
window.onSisLangChange = function () {
    if (!currentUser) return;
    loadOutgoingTransfers();
    loadIncomingTransfers();
    if (currentUser.is_registrar) {
        loadSections();
        loadUnassignedQueue();
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
    const graduationNav = document.getElementById('nav-graduation-wizard');
    if (graduationNav) {
        graduationNav.style.display = currentUser.is_registrar ? 'block' : 'none';
    }
    if (currentUser.is_registrar) {
        loadRecorders();
        loadEligibleTeachers();
        loadSections();
        loadUnassignedQueue();
        loadIssuanceLog();
        loadGraduationEligible();
        loadGraduationHistory();
    }
    if (currentUser.is_registrar || currentUser.is_recorder) {
        loadOutgoingTransfers();
        loadIncomingTransfers();
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
    window.location.href = '/teachers/dashboard.html';
}

document.addEventListener('DOMContentLoaded', loadCurrentUser);

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
            alert("Registration Failed: " + (result.error || "Unknown error"));
        }
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function fetchStudent() {
    const id = document.getElementById('search-id').value;
    if (!id) return alert("Please enter an ID!");

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
        alert("Student not found!");
    }
}

async function submitUpdate() {
    const id = document.getElementById('upd_id').value;
    if (!id) return alert("Search for a student first!");
    
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
            alert("Update failed: " + errorText);
        }
    } catch (err) {
        console.error("Fetch Error:", err);
        alert("Could not connect to the server.");
    }
}

async function fetchForPromotion() {
    const id = document.getElementById('promo-id').value.trim();
    const btn = document.querySelector('button[onclick="fetchForPromotion()"]');
    if (!id) return alert("Please enter a Student ID");

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
        alert(error.message);
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
    if (!action) return alert("Choose Promote or Retain.");

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
            alert(result.message);
            location.reload();
        } else {
            alert(result.error || "Promotion failed.");
        }
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
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
    if (!teacher_id) return alert("Choose a teacher first.");

    try {
        const res = await fetch('http://localhost:3001/api/registrar/recorders', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id })
        });
        const result = await res.json();
        if (!res.ok) return alert(result.error || "Could not assign recorder.");

        await loadRecorders();
        await loadEligibleTeachers();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
    }
}

async function removeRecorder(teacher_id) {
    if (!confirm("Remove this teacher's Recorder access?")) return;
    try {
        const res = await fetch(`http://localhost:3001/api/registrar/recorders/${teacher_id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const result = await res.json();
        if (!res.ok) return alert(result.error || "Could not remove recorder.");

        await loadRecorders();
        await loadEligibleTeachers();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
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

async function addSection() {
    const class_level = document.getElementById('sec_grade').value;
    const stream = document.getElementById('sec_stream').value;
    const section_name = document.getElementById('sec_name').value.trim();
    const max_capacity = document.getElementById('sec_capacity').value.trim();

    if (!class_level || !stream || !section_name) return alert("Grade, stream, and section name are required.");

    try {
        const res = await fetch('http://localhost:3001/api/registrar/sections', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ class_level, stream, section_name, max_capacity: max_capacity || null })
        });
        const result = await res.json();
        if (!res.ok) return alert(result.error || "Could not create section.");

        document.getElementById('sec_name').value = '';
        document.getElementById('sec_capacity').value = '';
        await loadSections();
        await loadUnassignedQueue();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
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
            alert(result.error || "Could not update section.");
            await loadSections();
            return;
        }
        await loadUnassignedQueue();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
    }
}

async function deleteSection(id) {
    if (!confirm("Delete this section? This can't be undone.")) return;
    try {
        const res = await fetch(`http://localhost:3001/api/registrar/sections/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const result = await res.json();
        if (!res.ok) return alert(result.error || "Could not delete section.");
        await loadSections();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
    }
}

// --- 6. Automated Section Placement Wizard (Registrar only) ---

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
        if (!res.ok) return alert(result.error || "Placement failed.");

        let summary = result.message;
        if (result.shortfall && result.shortfall.length > 0) {
            summary += `\n${result.shortfall.length} student(s) couldn't be placed — all active sections are full.`;
        }
        alert(summary);

        await loadUnassignedQueue();
        await loadSections();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
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
        if (!res.ok) return alert(result.error || "Placement failed.");

        let summary = result.message;
        if (result.skipped_buckets && result.skipped_buckets.length > 0) {
            summary += `\n${result.skipped_buckets.length} grade/stream group(s) skipped — no active sections configured.`;
        }
        if (result.shortfall && result.shortfall.length > 0) {
            summary += `\n${result.shortfall.length} student(s) couldn't be placed — all active sections are full.`;
        }
        alert(summary);

        await loadUnassignedQueue();
        await loadSections();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
    }
}
// --- 7. Transfer Navigation Hub (Registrar + Recorder) ---

function showTransferPane(which) {
    document.getElementById('transfer-outgoing-pane').style.display = which === 'outgoing' ? 'block' : 'none';
    document.getElementById('transfer-incoming-pane').style.display = which === 'incoming' ? 'block' : 'none';
}

async function startOutgoingTransfer() {
    const student_id = document.getElementById('out_student_id').value.trim();
    if (!student_id) return alert("Enter a Student ID first.");

    try {
        const res = await fetch('http://localhost:3001/api/registrar/transfers/outgoing', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_id })
        });
        const result = await res.json();
        if (!res.ok) return alert(result.error || "Could not start the transfer.");

        document.getElementById('outgoing-code-result').innerHTML = `
            <div class="search-box" style="flex-direction: column; align-items: flex-start; background: #eafaf1; border-color: #27ae60;">
                <strong>Transfer Code — share this with the receiving school:</strong>
                <div style="font-size: 22px; font-weight: bold; letter-spacing: 1px; margin: 8px 0;">${result.transfer_code}</div>
            </div>
        `;
        document.getElementById('out_student_id').value = '';
        await loadOutgoingTransfers();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
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

        container.innerHTML = transfers.map(t => `
            <div class="search-box" style="justify-content: space-between; align-items: center; flex-wrap: wrap;">
                <span>
                    <strong>${t.student_id}</strong> &nbsp; Code: ${t.transfer_code} &nbsp;
                    <span style="text-transform: capitalize;">${t.status}</span>
                    ${t.new_student_id ? ` &rarr; ${t.new_student_id}` : ''}
                    <br><span class="muted" style="font-size: 12px;">${formatDateBilingual(t.initiated_at)}</span>
                </span>
                ${t.status === 'pending' ? `<button type="button" onclick="cancelOutgoingTransfer(${t.id})" style="background:#e74c3c;">Cancel</button>` : ''}
            </div>
        `).join('');
    } catch (err) {
        console.error(err);
        container.innerHTML = '<p class="muted">Could not load outgoing transfers.</p>';
    }
}

async function cancelOutgoingTransfer(id) {
    if (!confirm("Cancel this transfer? The student will be restored to your active roster.")) return;
    try {
        const res = await fetch(`http://localhost:3001/api/registrar/transfers/outgoing/${id}/cancel`, {
            method: 'POST',
            credentials: 'include'
        });
        const result = await res.json();
        if (!res.ok) return alert(result.error || "Could not cancel the transfer.");
        await loadOutgoingTransfers();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
    }
}

async function lookupIncomingTransfer() {
    const transfer_code = document.getElementById('in_transfer_code').value.trim();
    if (!transfer_code) return alert("Enter a transfer code first.");
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
            </div>
        `;
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
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
        if (!res.ok) return alert(result.error || "Could not complete the transfer.");

        alert(result.message);
        document.getElementById('in_transfer_code').value = '';
        document.getElementById('incoming-preview').innerHTML = '';
        await loadIncomingTransfers();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
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
        return alert("First name, last name, sex, grade, and stream are required.");
    }

    try {
        const res = await fetch('http://localhost:3001/api/registrar/transfers/incoming/manual', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (!res.ok) return alert(result.error || "Could not add this student.");

        alert(result.message);
        document.getElementById('external-transfer-form').style.display = 'none';
        ['ext_first', 'ext_middle', 'ext_last', 'ext_sex', 'ext_grade', 'ext_stream', 'ext_phone', 'ext_fayda'].forEach(id => {
            document.getElementById(id).value = '';
        });
        await loadIncomingTransfers();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
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
    if (!student_id) return alert("Enter a Student ID first.");
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
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
    }
}

async function previewReportCard(student_id) {
    const preview = document.getElementById('doc-report-card-preview');
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
}

function previewTranscript(student_id) {
    // The transcript is a rich, multi-page certificate rendered
    // server-side (same generator the student self-service flow uses) —
    // opened directly rather than re-rendered in a preview pane.
    window.open(`http://localhost:3001/api/registrar/documents/transcript/${encodeURIComponent(student_id)}/pdf`, '_blank');
    setTimeout(loadIssuanceLog, 1500);
}

function downloadIdCard(student_id) {
    window.open(`http://localhost:3001/api/registrar/documents/id-card/${encodeURIComponent(student_id)}/docx`, '_blank');
    setTimeout(loadIssuanceLog, 1500);
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

        container.innerHTML = students.map(s => {
            const fullName = [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ');
            const badge = s.category === 'Eligible for Promotion' ? 'color:#27ae60;' : s.category === 'Detained/Retained' ? 'color:#e74c3c;' : 'color:#7f8c8d;';
            return `
                <div class="search-box" style="justify-content: space-between; align-items: center;">
                    <label style="font-weight: normal; display:flex; align-items:center; gap:10px;">
                        <input type="checkbox" class="grad-checkbox" value="${s.student_id}" />
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

async function processGraduation() {
    const checked = [...document.querySelectorAll('.grad-checkbox:checked')].map(cb => cb.value);
    const batch_tag = document.getElementById('grad_batch_tag').value.trim();
    const override_reason = document.getElementById('grad_override_reason').value.trim();

    if (checked.length === 0) return alert("Select at least one student.");
    if (!batch_tag) return alert('Enter a batch name (e.g. "Class of 2026").');

    try {
        const res = await fetch('http://localhost:3001/api/registrar/graduation/process', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_ids: checked, batch_tag, override_reason })
        });
        const result = await res.json();
        if (!res.ok) return alert(result.error || "Graduation processing failed.");

        let summary = result.message;
        if (result.skipped && result.skipped.length > 0) {
            summary += `\n\nSkipped:\n` + result.skipped.map(s => `${s.student_id}: ${s.reason}`).join('\n');
        }
        alert(summary);

        document.getElementById('grad_batch_tag').value = '';
        document.getElementById('grad_override_reason').value = '';
        await loadGraduationEligible();
        await loadGraduationHistory();
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
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