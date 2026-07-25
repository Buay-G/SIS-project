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
        refreshUnreadMessagesBadge();
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
                'teacher-setup': loadTeacherSetup,
                teachers: () => {},
                textbooks: loadTextbooks,
                absence: loadAbsenceTabs,
                timetable: () => {},
                'teacher-assignments': loadTeacherAssignments,
                'marks-review': loadMarksReview,
                'mark-cutoff': loadMarkCutoffPage,
                semester: loadSemesterStatus,
                conduct: () => {},
                'escalated-absence': loadEscalatedAbsence,
                disciplinary: loadDisciplinaryCases,
                'teacher-audit': loadTeacherAudit,
                'document-approvals': loadDocumentApprovals,
                recognition: loadRecognition,
                students: loadStudents,
                messages: () => loadMessages('inbox'),
                profile: loadDocumentStatus
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
    document.getElementById('students-class-filter')?.addEventListener('change', filterStudentsTable);
    document.getElementById('students-section-filter')?.addEventListener('change', filterStudentsTable);
    document.getElementById('students-stream-filter')?.addEventListener('change', filterStudentsTable);

    document.getElementById('teacher-setup-btn')?.addEventListener('click', onboardTeacher);
    document.getElementById('teacher-assignment-btn')?.addEventListener('click', saveTeacherAssignment);
    document.getElementById('hr-assign-btn')?.addEventListener('click', saveHomeroom);
    document.getElementById('ta-filter-teacher')?.addEventListener('change', (e) => loadTeacherAssignments(e.target.value));
    document.getElementById('mc-publish-btn')?.addEventListener('click', publishMarkCutoff);
    document.getElementById('msg-recipient-type')?.addEventListener('change', loadMessageRecipients);
    document.getElementById('msg-send-btn')?.addEventListener('click', sendAdminMessage);
    document.getElementById('msg-box-inbox-btn')?.addEventListener('click', () => switchMessageBox('inbox'));
    document.getElementById('msg-box-sent-btn')?.addEventListener('click', () => switchMessageBox('sent'));
    document.getElementById('profile-signature-file')?.addEventListener('change', (e) => uploadAdminDocument(e, 'signature'));
    document.getElementById('profile-stamp-file')?.addEventListener('change', (e) => uploadAdminDocument(e, 'stamp'));

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
            'teacher-setup': loadTeacherSetup, 'teacher-assignments': loadTeacherAssignments,
            'marks-review': loadMarksReview, 'mark-cutoff': loadMarkCutoffPage, semester: loadSemesterStatus,
            'escalated-absence': loadEscalatedAbsence, disciplinary: loadDisciplinaryCases,
            'teacher-audit': loadTeacherAudit,
            'document-approvals': loadDocumentApprovals, recognition: loadRecognition, students: loadStudents,
            messages: () => loadMessages(CURRENT_MESSAGE_BOX || 'inbox')
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
        const studentStatsRes = await apiFetch(`${API_BASE}/api/student-stats`);
        if (studentStatsRes.ok) {
            const s = await studentStatsRes.json();
            stats.push(statCard('🎒', t('sa_stat_total_students'), s.total, ''));
        }

        if (CURRENT_TITLE === 'Admin VP') {
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

        if (CURRENT_TITLE === 'Academic VP') {
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

            // Teacher Performance & Red-Flag Audit widget
            const auditRes = await apiFetch(`${API_BASE}/api/principal/teacher-audit`);
            if (auditRes.ok) {
                const auditData = await auditRes.json();
                const flagged = (auditData.teachers || []).filter(x => x.flagged);
                widgets.push(`
                    <div class="widget">
                        <h3>${t('sa_widget_red_flag')}
                            <span class="badge ${flagged.length > 0 ? 'badge-rejected' : 'badge-none'}">${flagged.length}</span>
                        </h3>
                        ${flagged.length === 0
                            ? `<div class="widget-empty">${t('sa_no_flags')}</div>`
                            : flagged.slice(0, 6).map(f => `
                                <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 4px; border-bottom:1px solid var(--border); cursor:pointer;" onclick="openTeacherAuditModal('${f.teacher_id}')">
                                    <span>${escapeHtml(f.full_name)}</span>
                                    <span>${f.flags.map(fl => `<span class="badge badge-rejected" style="margin-left:4px;">${fl.replace(/_/g, ' ')}</span>`).join('')}</span>
                                </div>`).join('')
                        }
                    </div>`);
            }
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
const GRADUATED_OR_TRANSFERRED = s => s.status === 'Graduated' || String(s.status || '').startsWith('Transferred');

async function loadStudents() {
    const tbody = document.getElementById('sa-students-tbody');
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/students`);
    if (res.ok) {
        ALL_STUDENTS = await res.json();
        populateStudentFilterOptions();
        filterStudentsTable();
    } else {
        tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`;
    }

    // The extra tabs (approve/reject, batches, this-year transfers) are
    // Principal-only per the spec — Admin VP/Academic VP still get the
    // shared roster tab above, just not these.
    const isPrincipal = CURRENT_TITLE === 'Principal';
    ['students-transfer-requests', 'students-transferred', 'students-batches'].forEach(tabName => {
        const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
        if (btn) btn.style.display = isPrincipal ? '' : 'none';
    });
    if (isPrincipal) {
        loadTransferRequests();
        loadTransferredStudents();
        loadGraduationBatches();
    }
}

function populateStudentFilterOptions() {
    const classSel = document.getElementById('students-class-filter');
    const sectionSel = document.getElementById('students-section-filter');
    const streamSel = document.getElementById('students-stream-filter');
    if (!classSel) return;
    const uniq = key => [...new Set(ALL_STUDENTS.map(s => s[key]).filter(Boolean))].sort();
    const buildOptions = (sel, values, allLabelKey) => {
        const current = sel.value;
        sel.innerHTML = `<option value="">${t(allLabelKey)}</option>` + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
        sel.value = current;
    };
    buildOptions(classSel, uniq('class_level'), 'sa_all_classes');
    buildOptions(sectionSel, uniq('section'), 'sa_all_sections');
    buildOptions(streamSel, uniq('stream'), 'sa_all_streams');
}

function renderStudentsTable(list) {
    const tbody = document.getElementById('sa-students-tbody');
    const statRow = document.getElementById('sa-students-stat-row');
    const total = list.length;
    const male = list.filter(s => s.sex === 'Male').length;
    const female = list.filter(s => s.sex === 'Female').length;
    if (statRow) {
        statRow.innerHTML = [
            statCard('🎒', t('sa_stat_total_students'), total, ''),
            statCard('👦', t('sa_stat_male_students'), male, ''),
            statCard('👧', t('sa_stat_female_students'), female, '')
        ].join('');
    }
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
    const q = (document.getElementById('students-filter')?.value || '').trim().toLowerCase();
    const classVal = document.getElementById('students-class-filter')?.value || '';
    const sectionVal = document.getElementById('students-section-filter')?.value || '';
    const streamVal = document.getElementById('students-stream-filter')?.value || '';

    // Graduated/transferred students live in their own tabs below, so the
    // main roster only shows currently-enrolled students.
    let list = ALL_STUDENTS.filter(s => !GRADUATED_OR_TRANSFERRED(s));
    if (q) {
        list = list.filter(s =>
            s.student_id.toLowerCase().includes(q) ||
            [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    if (classVal) list = list.filter(s => s.class_level === classVal);
    if (sectionVal) list = list.filter(s => s.section === sectionVal);
    if (streamVal) list = list.filter(s => s.stream === streamVal);
    renderStudentsTable(list);
}

// ---------- Transfer Requests (Student -> Principal -> Registrar) ----------
async function loadTransferRequests() {
    const tbody = document.getElementById('sa-transfer-requests-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/principal/transfer-requests`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.full_name)}</td>
            <td>${r.class_level}-${r.section}</td>
            <td>${escapeHtml(r.reason || '—')}</td>
            <td>${transferRequestStatusBadge(r)}</td>
            <td>${r.status === 'pending'
                ? `<button class="btn btn-sm btn-success" onclick="approveTransferRequest(${r.request_id})">${t('sa_approve')}</button>
                   <button class="btn btn-sm btn-danger" onclick="rejectTransferRequest(${r.request_id})">${t('sa_reject')}</button>`
                : '—'}</td>
        </tr>`).join('');
}

function transferRequestStatusBadge(r) {
    if (r.status === 'approved') return `<span class="badge badge-approved">${t('sa_tr_approved')}</span>`;
    if (r.status === 'cleared') return `<span class="badge badge-approved">${t('sa_tr_cleared')}</span>`;
    if (r.status === 'rejected') return `<span class="badge badge-rejected">${t('sa_tr_rejected')}</span>`;
    return `<span class="badge badge-pending">${t('sa_pending')}</span>`;
}

async function approveTransferRequest(request_id) {
    const res = await apiFetch(`${API_BASE}/api/principal/transfer-requests/${request_id}/approve`, { method: 'POST' });
    await handleJsonResponse(res, t('sa_tr_approved_msg'));
    loadTransferRequests();
}

async function rejectTransferRequest(request_id) {
    const reason = prompt(t('sa_decline_reason_prompt')) || '';
    const res = await apiFetch(`${API_BASE}/api/principal/transfer-requests/${request_id}/reject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason })
    });
    await handleJsonResponse(res, t('sa_tr_rejected_msg'));
    loadTransferRequests();
}

// ---------- Transferred Students (this year, read-only) ----------
async function loadTransferredStudents() {
    const tbody = document.getElementById('sa-transferred-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/principal/transferred-students`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.full_name)}</td>
            <td>${r.class_level}-${r.section}</td>
            <td>${escapeHtml(r.transfer_code || '—')}</td>
            <td><span class="badge ${r.transfer_status === 'completed' ? 'badge-approved' : 'badge-pending'}">${escapeHtml(r.transfer_status)}</span></td>
            <td>${new Date(r.completed_at || r.initiated_at).toLocaleDateString()}</td>
        </tr>`).join('');
}

// ---------- Graduation Batches (Registrar publishes; Principal reads) ----------
async function loadGraduationBatches() {
    const tbody = document.getElementById('sa-batches-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/principal/graduation-batches`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr style="cursor:pointer;" onclick="openBatchModal('${escapeHtml(r.graduation_batch)}')">
            <td>${escapeHtml(r.graduation_batch)}</td>
            <td>${r.total}</td>
            <td>${r.male}</td>
            <td>${r.female}</td>
        </tr>`).join('');
}

async function openBatchModal(batch) {
    openModal(`<h3>${escapeHtml(batch)}</h3><div id="batch-modal-body">${t('sa_loading')}</div>
        <div class="form-actions"><button class="btn btn-ghost" onclick="closeModal()">${t('sa_close')}</button></div>`);
    const res = await apiFetch(`${API_BASE}/api/principal/graduation-batches/${encodeURIComponent(batch)}`);
    const body = document.getElementById('batch-modal-body');
    if (!body) return;
    if (!res.ok) { body.innerHTML = t('sa_load_error'); return; }
    const students = await res.json();
    body.innerHTML = `
        <div class="data-table-wrap">
            <table class="data-table">
                <thead><tr><th>${t('sa_col_student_id')}</th><th>${t('sa_col_name')}</th><th>${t('sa_col_class')}</th></tr></thead>
                <tbody>${students.map(s => `
                    <tr><td>${s.student_id}</td><td>${escapeHtml(s.full_name)}</td><td>${s.class_level}-${s.section}</td></tr>
                `).join('')}</tbody>
            </table>
        </div>`;
}

// ---------- Utility ----------
function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// ==========================================================
// TEACHER SETUP, Stage 1 (Principal) — incoming from Zonal + direct local hire
// ==========================================================
async function loadTeacherSetup() {
    loadIncomingTeachers();

    const tbody = document.getElementById('sa-teacher-setup-tbody');
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/admin/teachers`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    const teachers = await res.json();
    if (teachers.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = teachers.map(tr => `
        <tr>
            <td>${tr.teacher_id}</td>
            <td>${escapeHtml(tr.full_name)}</td>
            <td>${escapeHtml(tr.contact_number || '—')}</td>
            <td>${tr.awaiting_assignment
                ? `<span class="badge badge-pending">${t('sa_awaiting_assignment')}</span>`
                : `<span class="badge badge-approved">${tr.assignment_count} ${t('sa_assignments_lower')}</span>`}</td>
        </tr>`).join('');
}

async function loadIncomingTeachers() {
    const tbody = document.getElementById('sa-incoming-teachers-tbody');
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/principal/incoming-teachers`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.full_name)}</td>
            <td>${escapeHtml(r.contact_number || '—')}</td>
            <td>${incomingStatusBadge(r)}</td>
            <td>${r.status === 'pending'
                ? `<button class="btn btn-sm btn-success" onclick="openAcceptIncomingModal(${r.incoming_id})">${t('sa_accept')}</button>
                   <button class="btn btn-sm btn-danger" onclick="declineIncomingTeacher(${r.incoming_id})">${t('sa_decline')}</button>`
                : '—'}</td>
        </tr>`).join('');
}

function incomingStatusBadge(r) {
    if (r.status === 'accepted') return `<span class="badge badge-approved">${t('sa_accepted')} (${r.teacher_id})</span>`;
    if (r.status === 'declined') return `<span class="badge badge-rejected">${t('sa_declined')}</span>`;
    return `<span class="badge badge-pending">${t('sa_pending')}</span>`;
}

function openAcceptIncomingModal(incoming_id) {
    openModal(`
        <h3>${t('sa_accept_incoming_heading')}</h3>
        <p class="page-subtitle">${t('sa_accept_incoming_hint')}</p>
        <div class="form-group">
            <label>${t('sa_temp_password_label')}</label>
            <input type="text" id="accept-incoming-password" />
        </div>
        <div class="form-actions">
            <button class="btn btn-accent" onclick="acceptIncomingTeacher(${incoming_id})">${t('sa_accept')}</button>
            <button class="btn btn-ghost" onclick="closeModal()">${t('sa_close')}</button>
        </div>
    `);
}

async function acceptIncomingTeacher(incoming_id) {
    const password = document.getElementById('accept-incoming-password').value.trim();
    if (!password) return showToast(t('sa_err_teacher_setup_required'), 'error');
    const res = await apiFetch(`${API_BASE}/api/principal/incoming-teachers/${incoming_id}/accept`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
    const data = await handleJsonResponse(res, t('sa_teacher_onboarded'));
    if (!data) return;
    closeModal();
    loadTeacherSetup();
}

async function declineIncomingTeacher(incoming_id) {
    const reason = prompt(t('sa_decline_reason_prompt')) || '';
    const res = await apiFetch(`${API_BASE}/api/principal/incoming-teachers/${incoming_id}/decline`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason })
    });
    await handleJsonResponse(res, t('sa_incoming_declined'));
    loadIncomingTeachers();
}

async function onboardTeacher() {
    const first_name = document.getElementById('ts-first-name').value.trim();
    const middle_name = document.getElementById('ts-middle-name').value.trim();
    const last_name = document.getElementById('ts-last-name').value.trim();
    const contact_number = document.getElementById('ts-contact-number').value.trim();
    const email = document.getElementById('ts-email').value.trim();
    const password = document.getElementById('ts-password').value.trim();
    if (!first_name || !last_name || !password) return showToast(t('sa_err_teacher_setup_required'), 'error');

    const res = await apiFetch(`${API_BASE}/api/principal/teachers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_name, middle_name, last_name, contact_number, email, password })
    });
    const data = await handleJsonResponse(res, t('sa_teacher_onboarded'));
    if (!data) return;
    ['ts-first-name', 'ts-middle-name', 'ts-last-name', 'ts-contact-number', 'ts-email', 'ts-password'].forEach(id => {
        document.getElementById(id).value = '';
    });
    loadTeacherSetup();
}

// ==========================================================
// TEACHING ASSIGNMENTS, Stage 2 (Academic VP)
// ==========================================================
let TA_TEACHERS_CACHE = [];

async function loadTeacherAssignments(filterTeacherId) {
    const canAssign = CURRENT_TITLE === 'Academic VP';
    document.getElementById('ta-assign-form').style.display = canAssign ? '' : 'none';
    const hrForm = document.getElementById('hr-assign-form');
    if (hrForm) hrForm.style.display = canAssign ? '' : 'none';

    const [teachersRes, subjectsRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/admin/teachers`),
        apiFetch(`${API_BASE}/api/subjects`)
    ]);
    const teachers = teachersRes.ok ? await teachersRes.json() : [];
    TA_TEACHERS_CACHE = teachers;
    const subjects = subjectsRes.ok ? await subjectsRes.json() : [];

    const teacherSelect = document.getElementById('ta-teacher-select');
    const subjectSelect = document.getElementById('ta-subject-select');
    const filterSelect = document.getElementById('ta-filter-teacher');
    const hrTeacherSelect = document.getElementById('hr-teacher-select');
    if (teacherSelect) teacherSelect.innerHTML = teachers.map(tr => `<option value="${tr.teacher_id}">${escapeHtml(tr.full_name)} (${tr.teacher_id})</option>`).join('');
    if (hrTeacherSelect) hrTeacherSelect.innerHTML = teachers.map(tr => `<option value="${tr.teacher_id}">${escapeHtml(tr.full_name)} (${tr.teacher_id})</option>`).join('');
    if (subjectSelect) subjectSelect.innerHTML = subjects.map(s => `<option value="${s.subject_id}">${escapeHtml(s.subject_name)}</option>`).join('');
    if (filterSelect) {
        const currentValue = filterTeacherId || filterSelect.value || '';
        filterSelect.innerHTML = `<option value="">${t('sa_ta_all_teachers')}</option>` +
            teachers.map(tr => `<option value="${tr.teacher_id}">${escapeHtml(tr.full_name)} (${tr.teacher_id})</option>`).join('');
        filterSelect.value = currentValue;
    }

    const tbody = document.getElementById('sa-teacher-assignments-tbody');
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const teacherIdFilter = filterTeacherId || filterSelect?.value || '';
    const url = teacherIdFilter
        ? `${API_BASE}/api/academic-vp/teacher-assignments?teacher_id=${encodeURIComponent(teacherIdFilter)}`
        : `${API_BASE}/api/academic-vp/teacher-assignments`;
    const res = await apiFetch(url);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.teacher_name)}</td>
            <td>${escapeHtml(r.subject_name)}</td>
            <td>${r.class_level}-${r.section}${r.stream ? ' (' + escapeHtml(r.stream) + ')' : ''}</td>
            <td>${canAssign
                ? `<button class="btn btn-sm btn-danger" onclick="removeTeacherAssignment('${r.teacher_id}','${r.class_level}','${r.section}','${r.subject_id}')">${t('sa_remove')}</button>`
                : '—'}</td>
        </tr>`).join('');

    renderTeacherRoles(teachers, canAssign);
}

// ==========================================================
// HOMEROOM ASSIGNMENT + ADDITIONAL REGISTRAR ROLE (Academic VP), Stage 2
// ==========================================================
function renderTeacherRoles(teachers, canAssign) {
    const tbody = document.getElementById('sa-teacher-roles-tbody');
    if (!tbody) return;
    if (teachers.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = teachers.map(tr => `
        <tr>
            <td>${escapeHtml(tr.full_name)}</td>
            <td>${tr.homeroom
                ? `${tr.homeroom.class_level}-${tr.homeroom.section}${tr.homeroom.stream ? ' (' + escapeHtml(tr.homeroom.stream) + ')' : ''}`
                : `<span class="badge badge-none">${t('sa_none')}</span>`}</td>
            <td>${tr.is_registrar
                ? `<span class="badge badge-approved">${t('sa_registrar_active')}</span>`
                : `<span class="badge badge-none">${t('sa_none')}</span>`}</td>
            <td>${canAssign ? `
                ${tr.homeroom ? `<button class="btn btn-sm btn-danger" onclick="removeTeacherHomeroom('${tr.teacher_id}')">${t('sa_remove')}</button>` : ''}
                ${!tr.is_registrar
                    ? `<button class="btn btn-sm btn-ghost" onclick="grantRegistrar('${tr.teacher_id}')">${t('sa_grant_registrar_btn')}</button>`
                    : `<button class="btn btn-sm btn-danger" onclick="revokeRegistrar('${tr.teacher_id}')">${t('sa_revoke_registrar_btn')}</button>`}
            ` : '—'}</td>
        </tr>`).join('');
}

async function saveHomeroom() {
    const teacher_id = document.getElementById('hr-teacher-select').value;
    const class_level = document.getElementById('hr-class-level').value.trim();
    const section = document.getElementById('hr-section').value.trim();
    const stream = document.getElementById('hr-stream').value.trim();
    if (!teacher_id || !class_level || !section) return showToast(t('sa_err_assignment_required'), 'error');

    const res = await apiFetch(`${API_BASE}/api/academic-vp/homeroom`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id, class_level, section, stream: stream || null })
    });
    await handleJsonResponse(res, t('sa_homeroom_assigned'));
    document.getElementById('hr-class-level').value = '';
    document.getElementById('hr-section').value = '';
    document.getElementById('hr-stream').value = '';
    loadTeacherAssignments();
}

async function removeTeacherHomeroom(teacher_id) {
    const res = await apiFetch(`${API_BASE}/api/academic-vp/homeroom`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id })
    });
    await handleJsonResponse(res, t('sa_homeroom_removed'));
    loadTeacherAssignments();
}

// Registrar is just a flag on the teacher's own row now — same login,
// no separate password to set, so this is a one-click confirm rather
// than a form.
async function grantRegistrar(teacher_id) {
    if (!confirm(t('sa_grant_registrar_confirm'))) return;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/grant-registrar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id })
    });
    await handleJsonResponse(res, t('sa_registrar_granted'));
    loadTeacherAssignments();
}

async function revokeRegistrar(teacher_id) {
    if (!confirm(t('sa_revoke_registrar_confirm'))) return;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/grant-registrar`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id })
    });
    await handleJsonResponse(res, t('sa_registrar_revoked'));
    loadTeacherAssignments();
}

async function saveTeacherAssignment() {
    const teacher_id = document.getElementById('ta-teacher-select').value;
    const subject_id = document.getElementById('ta-subject-select').value;
    const class_level = document.getElementById('ta-class-level').value.trim();
    const section = document.getElementById('ta-section').value.trim();
    const stream = document.getElementById('ta-stream').value.trim();
    if (!teacher_id || !subject_id || !class_level || !section) return showToast(t('sa_err_assignment_required'), 'error');

    const res = await apiFetch(`${API_BASE}/api/academic-vp/teacher-assignments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id, subject_id, class_level, section, stream: stream || null })
    });
    await handleJsonResponse(res, t('sa_assignment_saved'));
    document.getElementById('ta-class-level').value = '';
    document.getElementById('ta-section').value = '';
    document.getElementById('ta-stream').value = '';
    loadTeacherAssignments();
}

async function removeTeacherAssignment(teacher_id, class_level, section, subject_id) {
    const res = await apiFetch(`${API_BASE}/api/academic-vp/teacher-assignments`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id, class_level, section, subject_id })
    });
    await handleJsonResponse(res, t('sa_assignment_removed'));
    loadTeacherAssignments();
}

// ==========================================================
// MARK CUT-OFF (Academic VP)
// ==========================================================
async function loadMarkCutoffPage() {
    const canPublish = CURRENT_TITLE === 'Academic VP';
    document.getElementById('mc-publish-form').style.display = canPublish ? '' : 'none';

    const cutoffRes = await apiFetch(`${API_BASE}/api/academic-vp/mark-cutoff`);
    const cutoffData = cutoffRes.ok ? await cutoffRes.json() : { cutoff: 50 };
    document.getElementById('mc-cutoff-input').value = cutoffData.cutoff;
    document.getElementById('mc-current-hint').textContent = `${t('sa_mc_current_hint_prefix')} ${cutoffData.cutoff}%`;

    const tbody = document.getElementById('sa-below-cutoff-tbody');
    tbody.innerHTML = `<tr><td colspan="3">${t('sa_loading')}</td></tr>`;
    const belowRes = await apiFetch(`${API_BASE}/api/academic-vp/below-cutoff`);
    if (!belowRes.ok) { tbody.innerHTML = `<tr><td colspan="3">${t('sa_load_error')}</td></tr>`; return; }
    const belowData = await belowRes.json();
    if (!belowData.students || belowData.students.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3">${t('sa_no_data')}</td></tr>`;
        return;
    }
    tbody.innerHTML = belowData.students.map(s => `
        <tr>
            <td>${escapeHtml(s.full_name || s.student_id)}</td>
            <td>${s.class_level}-${s.section}${s.stream ? ' (' + escapeHtml(s.stream) + ')' : ''}</td>
            <td>${s.year_average}</td>
        </tr>`).join('');
}

async function publishMarkCutoff() {
    const cutoff = Number(document.getElementById('mc-cutoff-input').value);
    if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff > 100) return showToast(t('sa_err_cutoff_invalid'), 'error');
    const res = await apiFetch(`${API_BASE}/api/academic-vp/mark-cutoff`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cutoff })
    });
    await handleJsonResponse(res, t('sa_cutoff_published'));
    loadMarkCutoffPage();
}

// ==========================================================
// TEACHER PERFORMANCE & RED-FLAG AUDIT (Principal)
// ==========================================================
async function loadTeacherAudit() {
    const tbody = document.getElementById('sa-teacher-audit-tbody');
    tbody.innerHTML = `<tr><td colspan="5">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/principal/teacher-audit`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_load_error')}</td></tr>`; return; }
    const data = await res.json();
    if (!data.teachers || data.teachers.length === 0) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = data.teachers.map(tr => `
        <tr style="cursor:pointer; ${tr.flagged ? 'background:var(--danger-bg);' : ''}" onclick="openTeacherAuditModal('${tr.teacher_id}')">
            <td>${escapeHtml(tr.full_name)}</td>
            <td>${tr.absent_days_30d}</td>
            <td>${tr.punctuality_rate != null ? tr.punctuality_rate + '%' : '—'}</td>
            <td>${tr.avg_score != null ? tr.avg_score : '—'}</td>
            <td>${tr.flags.length === 0 ? '—' : tr.flags.map(f => `<span class="badge badge-rejected" style="margin-right:4px;">${f.replace(/_/g, ' ')}</span>`).join('')}</td>
        </tr>`).join('');
}

async function openTeacherAuditModal(teacher_id) {
    openModal(`<h3>${t('sa_loading')}</h3>`);
    const res = await apiFetch(`${API_BASE}/api/principal/teacher-audit/${encodeURIComponent(teacher_id)}`);
    if (!res.ok) { closeModal(); showToast(t('sa_load_error'), 'error'); return; }
    const d = await res.json();

    const attendanceRows = (d.attendance_last_30d || []).slice(0, 10).map(a =>
        `<tr><td>${a.attendance_date}</td><td><span class="badge badge-${a.status}">${a.status}</span></td></tr>`).join('') ||
        `<tr><td colspan="2">${t('sa_no_data')}</td></tr>`;

    const scoreRows = (d.subject_scores || []).map(s =>
        `<tr><td>${escapeHtml(s.subject_name)}</td><td>${escapeHtml(s.term)}</td><td>${s.avg_score}</td></tr>`).join('') ||
        `<tr><td colspan="3">${t('sa_no_data')}</td></tr>`;

    openModal(`
        <h3>${escapeHtml(d.full_name)} (${d.teacher_id})</h3>
        <div class="stat-row" style="margin-bottom:16px;">
            ${statCard('❌', t('sa_absent_count'), d.absent_days_30d, d.absent_days_30d > 0 ? 'danger' : '')}
            ${statCard('📈', t('sa_punctuality_rate'), d.punctuality.rate != null ? d.punctuality.rate + '%' : '—', '')}
        </div>
        <h4>${t('sa_attendance_last_30d')}</h4>
        <div class="data-table-wrap" style="margin-bottom:16px;">
            <table class="data-table"><thead><tr><th>${t('sa_col_date')}</th><th>${t('sa_col_status')}</th></tr></thead>
            <tbody>${attendanceRows}</tbody></table>
        </div>
        <h4>${t('sa_col_avg_score')}</h4>
        <div class="data-table-wrap">
            <table class="data-table"><thead><tr><th>${t('sa_col_subject')}</th><th>${t('sa_col_term')}</th><th>${t('sa_col_avg_score')}</th></tr></thead>
            <tbody>${scoreRows}</tbody></table>
        </div>
        <div class="form-actions">
            <button class="btn btn-ghost" onclick="closeModal()">${t('sa_close')}</button>
        </div>
    `);
}

// ==========================================================
// GENERIC MODAL HELPER
// ==========================================================
function openModal(innerHtml) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'sa-generic-modal';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = innerHtml;
    overlay.appendChild(box);
    document.getElementById('sa-audit-modal-root').appendChild(overlay);
}
function closeModal() {
    document.getElementById('sa-generic-modal')?.remove();
}

// ==========================================================
// UNIVERSAL CONTACT & MESSAGING HUB
// ==========================================================
let CURRENT_MESSAGE_BOX = 'inbox';
let MESSAGE_RECIPIENTS_CACHE = null;

async function loadMessageRecipients() {
    if (!MESSAGE_RECIPIENTS_CACHE) {
        const res = await apiFetch(`${API_BASE}/api/admin/messages/recipients`);
        MESSAGE_RECIPIENTS_CACHE = res.ok ? await res.json() : { teachers: [], admins: [], zonal_contact: null };
    }
    const type = document.getElementById('msg-recipient-type').value;
    const select = document.getElementById('msg-recipient-select');
    const wrap = document.getElementById('msg-recipient-picker-wrap');

    if (type === 'teachers') {
        wrap.style.display = '';
        select.innerHTML = MESSAGE_RECIPIENTS_CACHE.teachers.map(x => `<option value="${x.id}">${escapeHtml(x.full_name)}</option>`).join('') || `<option value="">${t('sa_no_data')}</option>`;
    } else if (type === 'school_admins') {
        wrap.style.display = '';
        select.innerHTML = MESSAGE_RECIPIENTS_CACHE.admins.map(x => `<option value="${x.id}">${escapeHtml(x.full_name)} (${escapeHtml(x.title)})</option>`).join('') || `<option value="">${t('sa_no_data')}</option>`;
    } else {
        // Zonal Admin Bridge — auto-routes to the zone's Head of Education, no picker needed
        wrap.style.display = 'none';
        select.innerHTML = MESSAGE_RECIPIENTS_CACHE.zonal_contact
            ? `<option value="${MESSAGE_RECIPIENTS_CACHE.zonal_contact.id}">${escapeHtml(MESSAGE_RECIPIENTS_CACHE.zonal_contact.full_name)}</option>`
            : '';
    }
}

async function sendAdminMessage() {
    const recipient_type = document.getElementById('msg-recipient-type').value;
    const recipient_id = document.getElementById('msg-recipient-select').value || null;
    const subject = document.getElementById('msg-subject').value.trim();
    const body = document.getElementById('msg-body').value.trim();
    if (!body) return showToast(t('sa_err_message_body_required'), 'error');

    const res = await apiFetch(`${API_BASE}/api/admin/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_type, recipient_id, subject, body })
    });
    const data = await handleJsonResponse(res, t('sa_message_sent'));
    if (!data) return;
    document.getElementById('msg-subject').value = '';
    document.getElementById('msg-body').value = '';
    if (CURRENT_MESSAGE_BOX === 'sent') loadMessages('sent');
}

function switchMessageBox(box) {
    CURRENT_MESSAGE_BOX = box;
    document.getElementById('msg-box-inbox-btn').className = box === 'inbox' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
    document.getElementById('msg-box-sent-btn').className = box === 'sent' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
    loadMessages(box);
}

async function loadMessages(box) {
    CURRENT_MESSAGE_BOX = box;
    if (!document.getElementById('msg-recipient-select').innerHTML) loadMessageRecipients();
    const listEl = document.getElementById('sa-messages-list');
    listEl.innerHTML = `<div class="widget-loading">${t('sa_loading')}</div>`;
    const res = await apiFetch(`${API_BASE}/api/admin/messages?box=${box}`);
    if (!res.ok) { listEl.innerHTML = `<div class="widget-empty">${t('sa_load_error')}</div>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { listEl.innerHTML = `<div class="widget-empty">${t('sa_no_data')}</div>`; return; }
    listEl.innerHTML = rows.map(m => `
        <div style="padding:12px 4px; border-bottom:1px solid var(--border); ${!m.is_read && box === 'inbox' ? 'font-weight:700;' : ''}">
            <div style="display:flex; justify-content:space-between;">
                <span>${escapeHtml(m.subject || t('sa_no_subject'))}</span>
                <span class="form-hint">${new Date(m.sent_at).toLocaleString()}</span>
            </div>
            <div class="form-hint">${box === 'inbox' ? escapeHtml(m.sender_type) : escapeHtml(m.recipient_type)}</div>
            <div>${escapeHtml(m.body)}</div>
            ${!m.is_read && box === 'inbox' ? `<button class="btn btn-sm btn-ghost" onclick="markMessageRead(${m.message_id})">${t('sa_mark_read')}</button>` : ''}
        </div>`).join('');
}

async function markMessageRead(message_id) {
    await apiFetch(`${API_BASE}/api/admin/messages/${message_id}/read`, { method: 'POST' });
    loadMessages(CURRENT_MESSAGE_BOX);
    refreshUnreadMessagesBadge();
}

async function refreshUnreadMessagesBadge() {
    const res = await apiFetch(`${API_BASE}/api/admin/messages?box=inbox`);
    const badge = document.getElementById('sa-messages-badge');
    if (!res.ok || !badge) return;
    const rows = await res.json();
    const unread = rows.filter(m => !m.is_read).length;
    if (unread > 0) { badge.style.display = 'inline-flex'; badge.textContent = unread; }
    else badge.style.display = 'none';
}

// ==========================================================
// DIGITAL SIGNATURE SUITE (school_admins' own signature/stamp)
// ==========================================================
async function loadDocumentStatus() {
    const res = await apiFetch(`${API_BASE}/api/admin/document-status`);
    if (!res.ok) return;
    const data = await res.json();
    const sigPreview = document.getElementById('profile-signature-preview');
    const stampPreview = document.getElementById('profile-stamp-preview');
    if (data.signature_url) { sigPreview.src = API_BASE + data.signature_url; sigPreview.style.display = ''; }
    if (data.stamp_url) { stampPreview.src = API_BASE + data.stamp_url; stampPreview.style.display = ''; }
}

async function uploadAdminDocument(event, kind) {
    const file = event.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append(kind, file);
    const res = await apiFetch(`${API_BASE}/api/admin/upload-${kind}`, { method: 'POST', body: formData });
    const data = await handleJsonResponse(res, kind === 'signature' ? t('sa_signature_uploaded') : t('sa_stamp_uploaded'));
    if (!data) return;
    const preview = document.getElementById(`profile-${kind}-preview`);
    const url = data.signature_url || data.stamp_url;
    if (url) { preview.src = API_BASE + url; preview.style.display = ''; }
}