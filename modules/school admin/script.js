// ==========================================================
// SCHOOL ADMIN PORTAL — shared by Principal / Admin VP / Academic VP
// (all school_admins, distinguished by title). Nav sections show/hide
// based on the logged-in title; Principal sees everything.
// ==========================================================

const API_BASE = 'http://localhost:3001';
let CURRENT_TITLE = null;
let CURRENT_ADMIN = null;

function apiFetch(url, options = {}) {
    return fetch(url, { credentials: 'include', ...options });
}

// ---------- Toast ----------
function showToast(message, type = '') {
    const container = document.getElementById('sa-toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type ? 'toast-' + type : ''}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

async function handleJsonResponse(res, successMsg) {
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
        showToast(data.error || 'Something went wrong.', 'error');
        return null;
    }
    if (successMsg) showToast(data.message || successMsg, 'success');
    return data;
}

// ---------- Auth / init ----------
async function checkAuthAndInit() {
    try {
        const res = await apiFetch(`${API_BASE}/api/me`);
        if (!res.ok) { window.location.href = '/login.html'; return; }
        const data = await res.json();
        if (data.role !== 'school_admins') { window.location.href = '/login.html'; return; }

        CURRENT_ADMIN = data;
        CURRENT_TITLE = data.title || 'Admin VP';

        document.getElementById('sa-school-name').textContent = data.school_name || '—';
        document.getElementById('sa-title-badge').textContent = CURRENT_TITLE;
        document.getElementById('profile-admin-id').textContent = data.user_id || '—';
        document.getElementById('profile-title').textContent = CURRENT_TITLE;
        document.getElementById('profile-school-name').textContent = data.school_name || '—';

        const initials = CURRENT_TITLE.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        document.getElementById('sa-avatar-initials').textContent = initials;
        document.getElementById('sa-profile-name').textContent = data.user_id || 'Admin';
        document.getElementById('sa-profile-title').textContent = CURRENT_TITLE;

        filterNavByTitle(CURRENT_TITLE);
        loadDashboard();
    } catch (err) {
        console.error('checkAuthAndInit error:', err);
        window.location.href = '/login.html';
    }
}

// Principal sees every section; Admin VP / Academic VP only see the
// nav items whose data-titles list includes their own title.
function filterNavByTitle(title) {
    document.querySelectorAll('#sa-nav-menu [data-titles]').forEach(el => {
        const allowed = el.getAttribute('data-titles').split(',').map(s => s.trim());
        el.style.display = allowed.includes(title) ? '' : 'none';
    });
}

// ---------- Nav / page switching ----------
document.addEventListener('DOMContentLoaded', () => {
    checkAuthAndInit();

    document.querySelectorAll('.nav-link[data-page]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const page = link.dataset.page;
            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            document.querySelectorAll('.page-content').forEach(p => p.classList.remove('active'));
            const target = document.getElementById(`page-${page}`);
            if (target) target.classList.add('active');
            document.getElementById('sa-page-title').textContent = link.querySelector('span:not(.nav-icon)').textContent;

            const loaders = {
                dashboard: loadDashboard,
                teachers: () => {},
                textbooks: loadTextbooks,
                absence: loadAbsenceTabs,
                timetable: () => {},
                'marks-review': loadMarksReview,
                semester: loadSemesterStatus,
                conduct: () => {},
                'escalated-absence': loadEscalatedAbsence,
                disciplinary: loadDisciplinaryCases,
                'document-approvals': loadDocumentApprovals,
                recognition: loadRecognition,
                students: loadStudents,
                profile: () => {}
            };
            if (loaders[page]) loaders[page]();

            if (window.innerWidth <= 900) document.getElementById('sidebar').classList.remove('open');
        });
    });

    document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
    });

    document.getElementById('sa-logout-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        try { await apiFetch(`${API_BASE}/api/logout`, { method: 'POST' }); } catch {}
        window.location.href = '/login.html';
    });

    // Wire up all the action buttons once, up front
    document.getElementById('mark-attendance-btn')?.addEventListener('click', markTeacherAttendance);
    document.getElementById('punctuality-lookup-btn')?.addEventListener('click', lookupPunctuality);
    document.getElementById('grant-leave-btn')?.addEventListener('click', grantTeacherLeave);
    document.getElementById('tt-load-btn')?.addEventListener('click', loadTimetable);
    document.getElementById('tt-add-btn')?.addEventListener('click', addTimetableSlot);
    document.getElementById('semester-start-btn')?.addEventListener('click', startSemester);
    document.getElementById('semester-close-btn')?.addEventListener('click', closeSemester);
    document.getElementById('send-warning-btn')?.addEventListener('click', sendConductWarning);
    document.getElementById('open-case-btn')?.addEventListener('click', openDisciplinaryCase);
    document.getElementById('students-filter')?.addEventListener('input', filterStudentsTable);

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
            document.getElementById(`tab-${btn.dataset.tab}`).style.display = 'block';
        });
    });
});

// re-render dynamic (JS-built) content when the language toggle is used
window.onSisLangChange = () => {
    const active = document.querySelector('.page-content.active');
    if (active) {
        const page = active.id.replace('page-', '');
        const loaders = {
            dashboard: loadDashboard, textbooks: loadTextbooks, absence: loadAbsenceTabs,
            'marks-review': loadMarksReview, semester: loadSemesterStatus,
            'escalated-absence': loadEscalatedAbsence, disciplinary: loadDisciplinaryCases,
            'document-approvals': loadDocumentApprovals, recognition: loadRecognition, students: loadStudents
        };
        if (loaders[page]) loaders[page]();
    }
};

// ==========================================================
// DASHBOARD — content depends on the logged-in title
// ==========================================================
async function loadDashboard() {
    document.getElementById('sa-hero-greeting').textContent = `${t('sa_hero_greeting')} — ${CURRENT_TITLE}`;
    const statsEl = document.getElementById('sa-dashboard-stats');
    const widgetsEl = document.getElementById('sa-dashboard-widgets');
    statsEl.innerHTML = `<div class="widget-loading">${t('sa_loading')}</div>`;
    widgetsEl.innerHTML = '';

    const stats = [];
    const widgets = [];

    try {
        if (CURRENT_TITLE === 'Admin VP' || CURRENT_TITLE === 'Principal') {
            const [pendingAbsenceRes, textbooksRes] = await Promise.all([
                apiFetch(`${API_BASE}/api/admin/teacher-absence-requests`),
                apiFetch(`${API_BASE}/api/admin/textbooks`)
            ]);
            const pendingAbsence = pendingAbsenceRes.ok ? await pendingAbsenceRes.json() : [];
            const textbooks = textbooksRes.ok ? await textbooksRes.json() : { log: [] };
            const lostCount = (textbooks.log || []).filter(r => r.status === 'lost').length;

            stats.push(statCard('📝', t('sa_stat_pending_teacher_absence'), pendingAbsence.length, pendingAbsence.length > 0 ? 'warning' : ''));
            stats.push(statCard('📘', t('sa_stat_lost_textbooks'), lostCount, lostCount > 0 ? 'danger' : ''));
        }

        if (CURRENT_TITLE === 'Academic VP' || CURRENT_TITLE === 'Principal') {
            const [termRes, marksRes] = await Promise.all([
                apiFetch(`${API_BASE}/api/term/current`),
                apiFetch(`${API_BASE}/api/academic-vp/marks-review`)
            ]);
            const term = termRes.ok ? await termRes.json() : {};
            const marks = marksRes.ok ? await marksRes.json() : [];
            const notPushed = marks.filter(m => !m.pushed).length;

            stats.push(statCard('🎓', t('sa_stat_current_term'), term.current_term || '—', ''));
            stats.push(statCard('📊', t('sa_stat_homerooms_not_pushed'), notPushed, notPushed > 0 ? 'warning' : 'success'));
        }

        if (CURRENT_TITLE === 'Principal') {
            const [escalatedRes, casesRes, docsRes] = await Promise.all([
                apiFetch(`${API_BASE}/api/principal/teacher-absence-requests`),
                apiFetch(`${API_BASE}/api/principal/disciplinary-cases`),
                apiFetch(`${API_BASE}/api/principal/teacher-document-requests`)
            ]);
            const escalated = escalatedRes.ok ? await escalatedRes.json() : [];
            const cases = casesRes.ok ? await casesRes.json() : [];
            const docs = docsRes.ok ? await docsRes.json() : [];

            stats.push(statCard('🚨', t('sa_stat_escalated_absence'), escalated.length, escalated.length > 0 ? 'danger' : ''));
            stats.push(statCard('🛑', t('sa_stat_pending_cases'), cases.length, cases.length > 0 ? 'danger' : ''));
            stats.push(statCard('🖋️', t('sa_stat_pending_documents'), docs.length, docs.length > 0 ? 'warning' : ''));

            const alertsCount = escalated.length + cases.length + docs.length;
            const alertsBadge = document.getElementById('sa-alerts-count');
            if (alertsCount > 0) { alertsBadge.style.display = 'flex'; alertsBadge.textContent = alertsCount; }
            else alertsBadge.style.display = 'none';
        }

        statsEl.innerHTML = stats.join('') || `<div class="widget-empty">${t('sa_no_data')}</div>`;
        widgetsEl.innerHTML = widgets.join('');
    } catch (err) {
        console.error('loadDashboard error:', err);
        statsEl.innerHTML = `<div class="widget-empty">${t('sa_load_error')}</div>`;
    }
}

function statCard(icon, label, value, tone) {
    return `<div class="stat-card ${tone ? 'stat-' + tone : ''}">
        <div class="stat-icon">${icon}</div>
        <div><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>
    </div>`;
}

// ==========================================================
// TEACHERS & ATTENDANCE (Admin VP)
// ==========================================================
async function markTeacherAttendance() {
    const teacher_id = document.getElementById('mark-attendance-teacher-id').value.trim();
    const status = document.getElementById('mark-attendance-status').value;
    if (!teacher_id) return showToast(t('sa_err_teacher_id_required'), 'error');
    const res = await apiFetch(`${API_BASE}/api/admin/mark-teacher-attendance`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id, status })
    });
    await handleJsonResponse(res, t('sa_attendance_recorded'));
}

async function lookupPunctuality() {
    const teacher_id = document.getElementById('punctuality-teacher-id').value.trim();
    const resultEl = document.getElementById('punctuality-result');
    if (!teacher_id) return showToast(t('sa_err_teacher_id_required'), 'error');
    resultEl.innerHTML = `<div class="widget-loading">${t('sa_loading')}</div>`;
    const res = await apiFetch(`${API_BASE}/api/admin/teacher-punctuality?teacher_id=${encodeURIComponent(teacher_id)}`);
    const data = await handleJsonResponse(res);
    if (!data) { resultEl.innerHTML = ''; return; }
    resultEl.innerHTML = `
        <div class="stat-row" style="margin-top:14px;">
            ${statCard('✅', t('sa_present_count'), data.present_count, 'success')}
            ${statCard('❌', t('sa_absent_count'), data.absent_count, data.absent_count > 0 ? 'danger' : '')}
            ${statCard('📈', t('sa_punctuality_rate'), data.punctuality_rate != null ? data.punctuality_rate + '%' : '—', '')}
        </div>`;
}

async function grantTeacherLeave() {
    const teacher_id = document.getElementById('leave-teacher-id').value.trim();
    const reason = document.getElementById('leave-reason').value.trim();
    const date_from = document.getElementById('leave-date-from').value;
    const date_to = document.getElementById('leave-date-to').value;
    if (!teacher_id || !date_from || !date_to) return showToast(t('sa_err_leave_fields_required'), 'error');
    const res = await apiFetch(`${API_BASE}/api/admin/teacher-leave`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id, date_from, date_to, reason })
    });
    await handleJsonResponse(res, t('sa_leave_granted'));
}

// ==========================================================
// TEXTBOOKS (Admin VP)
// ==========================================================
async function loadTextbooks() {
    const tbody = document.getElementById('sa-textbook-tbody');
    const summaryEl = document.getElementById('sa-textbook-summary');
    tbody.innerHTML = `<tr><td colspan="6">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/admin/textbooks`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_load_error')}</td></tr>`; return; }
    const data = await res.json();

    summaryEl.innerHTML = (data.summary || []).map(s => `
        <div class="stat-card">
            <div class="stat-icon">📘</div>
            <div><div class="stat-label">${s.subject_name}</div>
            <div class="stat-value" style="font-size:1rem;">${s.returned_count}/${s.total_issued} ${t('sa_returned_lower')}, ${s.lost_count} ${t('sa_lost_lower')}</div></div>
        </div>`).join('') || `<div class="widget-empty">${t('sa_no_data')}</div>`;

    if (!data.log || data.log.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6">${t('sa_no_data')}</td></tr>`;
        return;
    }
    tbody.innerHTML = data.log.map(r => `
        <tr>
            <td>${escapeHtml(r.full_name)} (${r.student_id})</td>
            <td>${r.class_level}-${r.section}</td>
            <td>${escapeHtml(r.subject_name)}</td>
            <td><span class="badge badge-${r.status}">${r.status}</span></td>
            <td>${r.status === 'lost' ? `<span class="badge badge-${r.penalty_status || 'pending'}">${r.penalty_status || 'pending'}</span>` : '—'}</td>
            <td>${r.status === 'lost' && (r.penalty_status === 'pending' || !r.penalty_status)
                ? `<button class="btn btn-sm btn-accent" onclick="decidePenalty('${r.student_id}', ${r.subject_id})">${t('sa_decide')}</button>`
                : '—'}</td>
        </tr>`).join('');
}

async function decidePenalty(student_id, subject_id) {
    const decision = prompt(t('sa_prompt_penalty_decision'));
    if (!decision || !['waived', 'charged'].includes(decision.trim())) return;
    let amount = null;
    if (decision.trim() === 'charged') {
        amount = prompt(t('sa_prompt_penalty_amount'));
        if (amount === null) return;
    }
    const note = prompt(t('sa_prompt_penalty_note')) || '';
    const res = await apiFetch(`${API_BASE}/api/admin/textbooks/penalty`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id, subject_id, decision: decision.trim(), amount, note })
    });
    await handleJsonResponse(res, t('sa_penalty_recorded'));
    loadTextbooks();
}

// ==========================================================
// ABSENCE REQUESTS (Admin VP)
// ==========================================================
function loadAbsenceTabs() {
    loadTeacherAbsenceRequests();
    loadStudentAbsenceEscalations();
}

async function loadTeacherAbsenceRequests() {
    const tbody = document.getElementById('sa-teacher-absence-tbody');
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/admin/teacher-absence-requests`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} (${r.teacher_id})</td>
            <td>${r.date_from} → ${r.date_to}</td>
            <td>${escapeHtml(r.reason || '—')}</td>
            <td>
                <button class="btn btn-sm btn-success" onclick="decideTeacherAbsence(${r.request_id}, 'approve', 'admin')">${t('sa_approve')}</button>
                <button class="btn btn-sm btn-danger" onclick="decideTeacherAbsence(${r.request_id}, 'reject', 'admin')">${t('sa_reject')}</button>
            </td>
        </tr>`).join('');
}

async function loadStudentAbsenceEscalations() {
    const tbody = document.getElementById('sa-student-absence-tbody');
    tbody.innerHTML = `<tr><td colspan="5">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/admin/absence-requests`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} (${r.student_id})</td>
            <td>${r.class_level}-${r.section}</td>
            <td>${r.date_from} → ${r.date_to}</td>
            <td>${escapeHtml(r.reason || '—')}</td>
            <td>
                <button class="btn btn-sm btn-success" onclick="decideStudentAbsence(${r.request_id}, 'approve')">${t('sa_approve')}</button>
                <button class="btn btn-sm btn-danger" onclick="decideStudentAbsence(${r.request_id}, 'reject')">${t('sa_reject')}</button>
            </td>
        </tr>`).join('');
}

async function decideTeacherAbsence(request_id, action, scope) {
    const base = scope === 'principal' ? '/api/principal/teacher-absence-requests' : '/api/admin/teacher-absence-requests';
    let body = {};
    if (action === 'reject') {
        const reason = prompt(t('sa_prompt_rejection_reason')) || '';
        body = { reason };
    }
    const res = await apiFetch(`${API_BASE}${base}/${request_id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    await handleJsonResponse(res, t('sa_done'));
    if (scope === 'principal') loadEscalatedAbsence(); else loadTeacherAbsenceRequests();
}

async function decideStudentAbsence(request_id, action) {
    let body = {};
    if (action === 'reject') {
        const reason = prompt(t('sa_prompt_rejection_reason')) || '';
        body = { reason };
    }
    const res = await apiFetch(`${API_BASE}/api/admin/absence-requests/${request_id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    await handleJsonResponse(res, t('sa_done'));
    loadStudentAbsenceEscalations();
}

// ==========================================================
// TIMETABLE (Academic VP)
// ==========================================================
async function loadTimetable() {
    const class_level = document.getElementById('tt-class-level').value.trim();
    const section = document.getElementById('tt-section').value.trim();
    const stream = document.getElementById('tt-stream').value.trim();
    const tbody = document.getElementById('sa-timetable-tbody');
    if (!class_level || !section || !stream) return showToast(t('sa_err_class_fields_required'), 'error');
    tbody.innerHTML = `<tr><td colspan="5">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/admin/timetable?class_level=${encodeURIComponent(class_level)}&section=${encodeURIComponent(section)}&stream=${encodeURIComponent(stream)}`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    const dayNames = ['', t('sa_monday'), t('sa_tuesday'), t('sa_wednesday'), t('sa_thursday'), t('sa_friday')];
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${dayNames[r.day_of_week] || r.day_of_week}</td>
            <td>${r.start_time} - ${r.end_time}</td>
            <td>${escapeHtml(r.subject_name)}</td>
            <td>${r.teacher_id || '—'}</td>
            <td><button class="btn btn-sm btn-danger" onclick="deleteTimetableSlot(${r.timetable_id})">${t('sa_delete')}</button></td>
        </tr>`).join('');
}

async function addTimetableSlot() {
    const class_level = document.getElementById('tt-class-level').value.trim();
    const section = document.getElementById('tt-section').value.trim();
    const stream = document.getElementById('tt-stream').value.trim();
    const day_of_week = document.getElementById('tt-day').value;
    const subject_id = document.getElementById('tt-subject-id').value.trim();
    const teacher_id = document.getElementById('tt-teacher-id').value.trim();
    const start_time = document.getElementById('tt-start-time').value;
    const end_time = document.getElementById('tt-end-time').value;
    if (!class_level || !section || !stream || !subject_id || !start_time || !end_time) {
        return showToast(t('sa_err_slot_fields_required'), 'error');
    }
    const res = await apiFetch(`${API_BASE}/api/admin/timetable`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ class_level, section, stream, day_of_week: Number(day_of_week), subject_id, teacher_id: teacher_id || null, start_time, end_time })
    });
    await handleJsonResponse(res, t('sa_slot_added'));
    loadTimetable();
}

async function deleteTimetableSlot(id) {
    const res = await apiFetch(`${API_BASE}/api/admin/timetable/${id}`, { method: 'DELETE' });
    await handleJsonResponse(res, t('sa_slot_removed'));
    loadTimetable();
}

// ==========================================================
// MARKS REVIEW (Academic VP)
// ==========================================================
async function loadMarksReview() {
    const tbody = document.getElementById('sa-marks-review-tbody');
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/marks-review`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.full_name)}</td>
            <td>${r.class_level}-${r.section} (${escapeHtml(r.stream || '')})</td>
            <td><span class="badge badge-${r.pushed ? 'approved' : 'pending'}">${r.pushed ? t('sa_pushed') : t('sa_not_pushed')}</span></td>
            <td>${r.pushed_at ? new Date(r.pushed_at).toLocaleString() : '—'}</td>
        </tr>`).join('');
}

// ==========================================================
// SEMESTER CONTROL (Academic VP)
// ==========================================================
async function loadSemesterStatus() {
    const el = document.getElementById('sa-semester-current');
    el.textContent = t('sa_loading');
    const res = await apiFetch(`${API_BASE}/api/term/current`);
    if (!res.ok) { el.textContent = t('sa_load_error'); return; }
    const data = await res.json();
    el.innerHTML = `${data.current_term} — <span class="badge badge-${data.semester_status === 'open' ? 'open' : 'closed'}">${data.semester_status}</span>`;
    document.getElementById('semester-term-select').value = data.current_term;
}

async function startSemester() {
    const term = document.getElementById('semester-term-select').value;
    const res = await apiFetch(`${API_BASE}/api/term/set`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ term })
    });
    await handleJsonResponse(res, t('sa_semester_started'));
    loadSemesterStatus();
}

async function closeSemester() {
    const res = await apiFetch(`${API_BASE}/api/term/close`, { method: 'POST' });
    await handleJsonResponse(res, t('sa_semester_closed'));
    loadSemesterStatus();
}

// ==========================================================
// STUDENT CONDUCT (Academic VP)
// ==========================================================
async function sendConductWarning() {
    const student_id = document.getElementById('warning-student-id').value.trim();
    const message = document.getElementById('warning-message').value.trim();
    if (!student_id || !message) return showToast(t('sa_err_warning_fields_required'), 'error');
    const res = await apiFetch(`${API_BASE}/api/academic-vp/conduct-warning`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id, message })
    });
    const data = await handleJsonResponse(res, t('sa_warning_sent'));
    if (data) { document.getElementById('warning-student-id').value = ''; document.getElementById('warning-message').value = ''; }
}

async function openDisciplinaryCase() {
    const student_id = document.getElementById('case-student-id').value.trim();
    const description = document.getElementById('case-description').value.trim();
    if (!student_id || !description) return showToast(t('sa_err_case_fields_required'), 'error');
    const res = await apiFetch(`${API_BASE}/api/academic-vp/disciplinary-cases`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id, description })
    });
    const data = await handleJsonResponse(res, t('sa_case_opened'));
    if (data) { document.getElementById('case-student-id').value = ''; document.getElementById('case-description').value = ''; }
}

// ==========================================================
// ESCALATED ABSENCES (Principal)
// ==========================================================
async function loadEscalatedAbsence() {
    const tbody = document.getElementById('sa-escalated-absence-tbody');
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/principal/teacher-absence-requests`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} (${r.teacher_id})</td>
            <td>${r.date_from} → ${r.date_to}</td>
            <td>${escapeHtml(r.reason || '—')}</td>
            <td>
                <button class="btn btn-sm btn-success" onclick="decideTeacherAbsence(${r.request_id}, 'approve', 'principal')">${t('sa_approve')}</button>
                <button class="btn btn-sm btn-danger" onclick="decideTeacherAbsence(${r.request_id}, 'reject', 'principal')">${t('sa_reject')}</button>
            </td>
        </tr>`).join('');
}

// ==========================================================
// DISCIPLINARY CASES (Principal)
// ==========================================================
async function loadDisciplinaryCases() {
    const tbody = document.getElementById('sa-disciplinary-tbody');
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/principal/disciplinary-cases`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} (${r.student_id})</td>
            <td>${r.class_level}-${r.section}</td>
            <td>${escapeHtml(r.description)}</td>
            <td>
                <button class="btn btn-sm btn-ghost" onclick="decideCase(${r.case_id}, 'dismissed')">${t('sa_dismiss')}</button>
                <button class="btn btn-sm btn-danger" onclick="decideCase(${r.case_id}, 'terminated')">${t('sa_terminate')}</button>
            </td>
        </tr>`).join('');
}

async function decideCase(case_id, decision) {
    if (decision === 'terminated' && !confirm(t('sa_confirm_terminate'))) return;
    const note = prompt(t('sa_prompt_decision_note')) || '';
    const res = await apiFetch(`${API_BASE}/api/principal/disciplinary-cases/${case_id}/decide`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note })
    });
    await handleJsonResponse(res, t('sa_case_decided'));
    loadDisciplinaryCases();
}

// ==========================================================
// DOCUMENT APPROVALS (Principal)
// ==========================================================
async function loadDocumentApprovals() {
    const tbody = document.getElementById('sa-document-approvals-tbody');
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/principal/teacher-document-requests`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.teacher_name)} (${r.teacher_id})</td>
            <td>${r.doc_type === 'signature' ? t('sa_doc_type_signature') : t('sa_doc_type_id_photo')}</td>
            <td><img src="${r.requested_file_url}" alt="" style="height:40px;border-radius:6px;"></td>
            <td>
                <button class="btn btn-sm btn-success" onclick="decideDocumentRequest(${r.request_id}, 'approve')">${t('sa_approve')}</button>
                <button class="btn btn-sm btn-danger" onclick="decideDocumentRequest(${r.request_id}, 'reject')">${t('sa_reject')}</button>
            </td>
        </tr>`).join('');
}

async function decideDocumentRequest(request_id, action) {
    let body = {};
    if (action === 'reject') body = { reason: prompt(t('sa_prompt_rejection_reason')) || '' };
    const res = await apiFetch(`${API_BASE}/api/principal/teacher-document-requests/${request_id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    await handleJsonResponse(res, t('sa_done'));
    loadDocumentApprovals();
}

// ==========================================================
// RECOGNITION AWARDS (Principal)
// ==========================================================
async function loadRecognition() {
    const tbody = document.getElementById('sa-recognition-tbody');
    tbody.innerHTML = `<tr><td colspan="5">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/principal/school-leaderboard`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_load_error')}</td></tr>`; return; }
    const data = await res.json();
    const ranked = (data.ranked || []).slice(0, 15);
    if (ranked.length === 0) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = ranked.map(r => `
        <tr>
            <td>#${r.rank}</td>
            <td>${escapeHtml(r.full_name || r.student_id)}</td>
            <td>${r.class_level}-${r.section}</td>
            <td>${r.year_average}</td>
            <td>${r.rank === 1
                ? (r.already_awarded
                    ? `<span class="badge badge-approved">${t('sa_awarded')}</span>`
                    : `<button class="btn btn-sm btn-accent" onclick="issueAward('${r.student_id}')">${t('sa_award')}</button>`)
                : '—'}</td>
        </tr>`).join('');
}

async function issueAward(student_id) {
    const res = await apiFetch(`${API_BASE}/api/principal/recognition-awards`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ student_id })
    });
    await handleJsonResponse(res, t('sa_award_issued'));
    loadRecognition();
}

// ==========================================================
// STUDENTS
// ==========================================================
let ALL_STUDENTS = [];
async function loadStudents() {
    const tbody = document.getElementById('sa-students-tbody');
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/students`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    ALL_STUDENTS = await res.json();
    renderStudentsTable(ALL_STUDENTS);
}
function renderStudentsTable(list) {
    const tbody = document.getElementById('sa-students-tbody');
    if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = list.map(s => `
        <tr>
            <td>${s.student_id}</td>
            <td>${escapeHtml([s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' '))}</td>
            <td>${s.class_level}-${s.section}</td>
            <td>${escapeHtml(s.status || '—')}</td>
        </tr>`).join('');
}
function filterStudentsTable() {
    const q = document.getElementById('students-filter').value.trim().toLowerCase();
    if (!q) return renderStudentsTable(ALL_STUDENTS);
    renderStudentsTable(ALL_STUDENTS.filter(s =>
        s.student_id.toLowerCase().includes(q) ||
        [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ').toLowerCase().includes(q)
    ));
}

// ---------- Utility ----------
function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}