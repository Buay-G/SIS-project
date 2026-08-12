// ==========================================================
// SCHOOL ADMIN PORTAL — shared by Principal / Admin VP / Academic VP
// (all school_admins, distinguished by title). Nav sections show/hide
// based on the logged-in title; Principal sees everything.
// ==========================================================

const API_BASE = 'http://localhost:3001';
let CURRENT_TITLE = null;
let STUDENTS_ON_LEAVE_CACHE = [];
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
        const displayName = data.admin_full_name || data.user_id || 'Admin';

        document.getElementById('sa-school-name').textContent = data.school_name || '—';
        document.getElementById('sa-title-badge').textContent = CURRENT_TITLE;
        document.getElementById('sa-nav-admin-id').textContent = data.user_id || '—';
        document.getElementById('profile-admin-id').textContent = data.user_id || '—';
        document.getElementById('profile-admin-id-2').textContent = data.user_id || '—';
        document.getElementById('profile-title').textContent = CURRENT_TITLE;
        document.getElementById('profile-school-name').textContent = data.school_name || '—';
        document.getElementById('profile-header-name').textContent = displayName;
        document.getElementById('profile-header-title').textContent = CURRENT_TITLE;

        document.getElementById('topbar-school-name').textContent = data.school_name || '—';
        document.getElementById('topbar-moe-code').textContent = data.moe_school_code ? `MOE ${data.moe_school_code}` : 'MOE —';

        // Name-based initials (e.g. "Abebe Kebede" -> "AK") when we have a
        // real name; otherwise fall back to the title ("Admin VP" -> "AV").
        const initialsSource = data.admin_full_name ? data.admin_full_name.split(' ').filter(Boolean) : CURRENT_TITLE.split(' ');
        const initials = initialsSource.map(w => w[0]).join('').slice(0, 2).toUpperCase();
        document.getElementById('sa-avatar-initials-text').textContent = initials;
        document.getElementById('profile-avatar-initials-text').textContent = initials;
        document.getElementById('sa-profile-name').textContent = displayName;
        document.getElementById('sa-profile-title').textContent = CURRENT_TITLE;

        if (data.avatar_url) {
            const fullUrl = API_BASE + data.avatar_url;
            const topbarImg = document.getElementById('sa-avatar-img');
            topbarImg.src = fullUrl; topbarImg.style.display = '';
            document.getElementById('sa-avatar-initials-text').style.display = 'none';
            const profileImg = document.getElementById('profile-avatar-img');
            profileImg.src = fullUrl; profileImg.style.display = '';
            document.getElementById('profile-avatar-initials-text').style.display = 'none';
        }

        renderTopbarAcademicYear();
        filterNavByTitle(CURRENT_TITLE);
        loadDashboard();
        loadTopbarSemester();
        refreshUnreadMessagesBadge();
        loadAlertsDropdown();
    } catch (err) {
        console.error('checkAuthAndInit error:', err);
        window.location.href = '/login.html';
    }
}

// Topbar "Academic Year" label — replaces the old (unused) search box.
// The Ethiopian school year is identified by a single Ethiopian year
// (Meskerem–Sene/Hamle), so this shows just that, with the two-Gregorian-
// year span in brackets per the portal's Ethiopian-first date convention.
// Recomputes itself automatically every Ethiopian New Year since it's
// derived from today's date, not a stored value.
function renderTopbarAcademicYear() {
    const el = document.getElementById('topbar-academic-year-text');
    if (!el) return;
    if (typeof EthCal === 'undefined') { el.textContent = '—'; return; }
    const todayEth = EthCal.toEthiopian(new Date());
    const gcStart = EthCal.toGregorianDate(todayEth.year, 1, 1).getFullYear(); // Meskerem 1 of this EC year
    el.textContent = t('sa_topbar_academic_year', { year: todayEth.year, gcRange: `${gcStart}/${gcStart + 1}` });
}

// The top-bar's "Semester: Open/Closed" chip — a lightweight read of the
// same /api/term/current endpoint the Semester Control page uses, so it's
// visible from anywhere in the portal, not just the Semester page. Kept
// separate from loadSemesterStatus() (which also needs to fill in the
// Semester page's own term-select dropdown when that page is open).
async function loadTopbarSemester() {
    const chip = document.getElementById('topbar-semester-chip');
    if (!chip) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/term/current`);
        if (!res.ok) throw new Error('term/current failed');
        const data = await res.json();
        const isOpen = data.semester_status === 'open';
        chip.textContent = `${data.current_term} · ${isOpen ? t('sa_semester_open_label') : t('sa_semester_closed_label')}`;
        chip.classList.toggle('is-open', isOpen);
        chip.classList.toggle('is-closed', !isOpen);
    } catch (err) {
        console.error('loadTopbarSemester error:', err);
        chip.textContent = '—';
    }
}

// ==========================================================
// NOTIFICATIONS (bell) DROPDOWN
// Independent of the Dashboard page — works from anywhere in the portal,
// and is role-aware: each title only ever sees the items it actually has
// authority over (mirrors the server's own role gates), with the
// absence-request items rendered as real Approve/Reject buttons rather
// than plain text, wired straight into the same decide functions the
// dedicated list pages already use.
// ==========================================================
let ALERTS_DROPDOWN_OPEN = false;

function toggleAlertsDropdown() {
    const panel = document.getElementById('sa-alerts-dropdown');
    ALERTS_DROPDOWN_OPEN = !ALERTS_DROPDOWN_OPEN;
    panel.style.display = ALERTS_DROPDOWN_OPEN ? 'flex' : 'none';
    if (ALERTS_DROPDOWN_OPEN) loadAlertsDropdown();
}

document.addEventListener('click', (e) => {
    const wrap = document.getElementById('sa-alerts-wrap');
    if (ALERTS_DROPDOWN_OPEN && wrap && !wrap.contains(e.target)) {
        ALERTS_DROPDOWN_OPEN = false;
        document.getElementById('sa-alerts-dropdown').style.display = 'none';
    }
});

function alertItemHtml({ title, meta, actionsHtml }) {
    return `<div class="alert-item">
        <div class="alert-item-title">${title}</div>
        ${meta ? `<div class="alert-item-meta">${meta}</div>` : ''}
        ${actionsHtml ? `<div class="alert-item-actions">${actionsHtml}</div>` : ''}
    </div>`;
}

// Fetches this role's own pending items, updates the bell badge, and (if
// the panel happens to be open) re-renders its contents. Safe to call
// often — on init, on bell click, and after every approve/reject so the
// badge count and list stay in sync without a manual page refresh.
async function loadAlertsDropdown() {
    if (!CURRENT_TITLE) return;
    const badge = document.getElementById('sa-alerts-count');
    const body = document.getElementById('sa-alerts-dropdown-body');
    let items = [];

    try {
        if (CURRENT_TITLE === 'Admin VP') {
            const res = await apiFetch(`${API_BASE}/api/admin/teacher-absence-requests`);
            const rows = res.ok ? await res.json() : [];
            items = rows.map(r => alertItemHtml({
                title: `${lucideIcon('user', 15)} ${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} (${r.teacher_id})`,
                meta: `${t('sa_nav_absence')}: ${formatEthDateRange(r.date_from, r.date_to)}${r.reason ? ' · ' + escapeHtml(r.reason) : ''}`,
                actionsHtml: `
                    <button class="btn btn-success" onclick="decideTeacherAbsence(${r.request_id}, 'approve', 'admin')">${t('sa_approve')}</button>
                    <button class="btn btn-danger" onclick="decideTeacherAbsence(${r.request_id}, 'reject', 'admin')">${t('sa_reject')}</button>
                    <button class="btn btn-ghost" onclick="navigateToPage('absence')">${t('sa_view')}</button>`
            }));
        } else if (CURRENT_TITLE === 'Academic VP') {
            const res = await apiFetch(`${API_BASE}/api/admin/absence-requests`);
            const rows = res.ok ? await res.json() : [];
            items = rows.map(r => alertItemHtml({
                title: `${lucideIcon('user', 15)} ${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} (${r.student_id})`,
                meta: `${r.class_level}-${r.section} · ${formatEthDateRange(r.date_from, r.date_to)}`,
                actionsHtml: `
                    <button class="btn btn-success" onclick="decideStudentAbsence(${r.request_id}, 'approve')">${t('sa_approve')}</button>
                    <button class="btn btn-danger" onclick="decideStudentAbsence(${r.request_id}, 'reject')">${t('sa_reject')}</button>
                    <button class="btn btn-ghost" onclick="navigateToPage('student-absence-escalations')">${t('sa_view')}</button>`
            }));
        } else if (CURRENT_TITLE === 'Principal') {
            const [escRes, casesRes, docsRes] = await Promise.all([
                apiFetch(`${API_BASE}/api/principal/teacher-absence-requests`),
                apiFetch(`${API_BASE}/api/principal/disciplinary-cases`),
                apiFetch(`${API_BASE}/api/principal/teacher-document-requests`)
            ]);
            const escalated = escRes.ok ? await escRes.json() : [];
            const cases = casesRes.ok ? await casesRes.json() : [];
            const docs = docsRes.ok ? await docsRes.json() : [];

            items = escalated.map(r => alertItemHtml({
                title: `${lucideIcon('triangle-alert', 15)} ${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} (${r.teacher_id})`,
                meta: `${t('sa_nav_escalated_absence')}: ${formatEthDateRange(r.date_from, r.date_to)}${r.reason ? ' · ' + escapeHtml(r.reason) : ''}`,
                actionsHtml: `
                    <button class="btn btn-success" onclick="decideTeacherAbsence(${r.request_id}, 'approve', 'principal')">${t('sa_approve')}</button>
                    <button class="btn btn-danger" onclick="decideTeacherAbsence(${r.request_id}, 'reject', 'principal')">${t('sa_reject')}</button>
                    <button class="btn btn-ghost" onclick="navigateToPage('escalated-absence')">${t('sa_view')}</button>`
            }));
            items = items.concat(cases.map(r => alertItemHtml({
                title: `${lucideIcon('shield-alert', 15)} ${escapeHtml(r.full_name || r.student_id)}`,
                meta: escapeHtml(r.description || ''),
                actionsHtml: `<button class="btn btn-ghost" onclick="navigateToPage('disciplinary')">${t('sa_view')}</button>`
            })));
            items = items.concat(docs.map(r => alertItemHtml({
                title: `${lucideIcon('signature', 15)} ${escapeHtml(r.teacher_name)} (${r.teacher_id})`,
                meta: r.doc_type === 'signature' ? t('sa_doc_type_signature') : t('sa_doc_type_id_photo'),
                actionsHtml: `<button class="btn btn-ghost" onclick="navigateToPage('document-approvals')">${t('sa_view')}</button>`
            })));
        }
    } catch (err) {
        console.error('loadAlertsDropdown error:', err);
    }

    if (badge) {
        if (items.length > 0) { badge.style.display = 'flex'; badge.textContent = items.length; }
        else badge.style.display = 'none';
    }
    if (body) {
        body.innerHTML = items.length > 0 ? items.join('') : `<div class="alerts-dropdown-empty">${t('sa_no_flags')}</div>`;
    }
}

// Small helper so a dropdown item's "View" button can jump straight to the
// right nav section (reuses whatever nav-click wiring already exists —
// just simulates a click on the matching sidebar link).
function navigateToPage(page) {
    ALERTS_DROPDOWN_OPEN = false;
    document.getElementById('sa-alerts-dropdown').style.display = 'none';
    document.querySelector(`#sa-nav-menu [data-page="${page}"]`)?.click();
}


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
                teachers: loadTeacherLeaderboard,
                textbooks: loadTextbooks,
                absence: loadAbsenceTabs,
                'student-absence-escalations': loadStudentAbsenceEscalations,
                timetable: initTimetablePage,
                'teacher-assignments': loadTeacherAssignments,
                'marks-review': loadMarksReview,
                'mark-cutoff': loadMarkCutoffPage,
                semester: loadSemesterStatus,
                conduct: () => {},
                'escalated-absence': loadEscalatedAbsence,
                disciplinary: loadDisciplinaryCases,
                'teacher-audit': loadTeacherAudit,
                'subject-entry-requests': loadSubjectEntryRequests,
                'dropout-requests': loadDropoutRequests,
                'analysis-report': loadAnalysisReport,
                'document-approvals': loadDocumentApprovals,
                recognition: loadRecognition,
                'class-leaderboard': loadClassLeaderboard,
                students: loadStudents,
                messages: () => switchMessageBox('inbox'),
                profile: loadDocumentStatus,
                'id-card': loadAdminIdCard
            };
            if (loaders[page]) loaders[page]();

            if (window.innerWidth <= 900) {
                document.getElementById('sidebar').classList.remove('open');
                document.getElementById('sidebar-backdrop')?.classList.remove('active');
            }
        });
    });

    document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
        document.getElementById('sidebar-backdrop')?.classList.toggle('active');
    });

    document.getElementById('sidebar-backdrop')?.addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-backdrop').classList.remove('active');
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
    document.getElementById('tt-class-level')?.addEventListener('change', (e) => {
        updateStreamOptionsForLevel(document.getElementById('tt-stream'), e.target.value);
        renderTtSectionOptions();
        refreshTimetableSubjectOptions();
        refreshTimetableTeacherDisplay();
    });
    document.getElementById('tt-stream')?.addEventListener('change', () => {
        renderTtSectionOptions();
        refreshTimetableSubjectOptions();
        refreshTimetableTeacherDisplay();
    });
    document.getElementById('tt-section')?.addEventListener('change', refreshTimetableTeacherDisplay);
    document.getElementById('tt-subject-id')?.addEventListener('change', refreshTimetableTeacherDisplay);
    document.getElementById('tt-start-time')?.addEventListener('input', (e) =>
        showEthiopianTimeHint('tt-start-time-eth', e.target.value));
    document.getElementById('tt-end-time')?.addEventListener('input', (e) =>
        showEthiopianTimeHint('tt-end-time-eth', e.target.value));
    document.getElementById('ta-class-level')?.addEventListener('change', (e) => {
        updateStreamOptionsForLevel(document.getElementById('ta-stream'), e.target.value);
        renderTaSectionCheckboxes();
        refreshAssignmentSubjectOptions();
    });
    document.getElementById('ta-stream')?.addEventListener('change', () => {
        renderTaSectionCheckboxes();
        refreshAssignmentSubjectOptions();
    });
    document.getElementById('hr-class-level')?.addEventListener('change', (e) =>
        updateStreamOptionsForLevel(document.getElementById('hr-stream'), e.target.value));
    wireTeacherSearch('ta-teacher-search', 'ta-teacher-search-btn', 'ta-teacher-search-results', 'ta-teacher-select');
    wireTeacherSearch('hr-teacher-search', 'hr-teacher-search-btn', 'hr-teacher-search-results', 'hr-teacher-select');
    document.getElementById('subj-edit-btn')?.addEventListener('click', requestSubjectConfigEdit);
    document.getElementById('subj-save-btn')?.addEventListener('click', saveSubjectConfigGrid);
    document.getElementById('subj-remove-orphaned-btn')?.addEventListener('click', removeOrphanedSubjects);
    document.getElementById('semester-start-btn')?.addEventListener('click', startSemester);
    document.getElementById('semester-close-btn')?.addEventListener('click', closeSemester);
    document.getElementById('send-warning-btn')?.addEventListener('click', sendConductWarning);
    document.getElementById('open-case-btn')?.addEventListener('click', openDisciplinaryCase);
    document.getElementById('students-filter')?.addEventListener('input', filterStudentsTable);
    document.getElementById('students-class-filter')?.addEventListener('change', filterStudentsTable);
    document.getElementById('students-section-filter')?.addEventListener('change', filterStudentsTable);
    document.getElementById('students-stream-filter')?.addEventListener('change', filterStudentsTable);
    document.getElementById('lb-class-filter')?.addEventListener('change', () => {
        updateLeaderboardStreamFilterForClass();
        renderClassLeaderboard();
    });
    document.getElementById('lb-section-filter')?.addEventListener('change', renderClassLeaderboard);
    document.getElementById('lb-stream-filter')?.addEventListener('change', renderClassLeaderboard);

    document.getElementById('direct-transfer-btn')?.addEventListener('click', initiateDirectTransfer);
    document.getElementById('teacher-assignment-btn')?.addEventListener('click', saveTeacherAssignment);
    document.getElementById('hr-assign-btn')?.addEventListener('click', saveHomeroom);
    document.getElementById('ta-filter-teacher')?.addEventListener('change', (e) => loadTeacherAssignments(e.target.value));
    document.getElementById('mc-publish-btn')?.addEventListener('click', publishMarkCutoff);
    document.getElementById('msg-new-btn')?.addEventListener('click', () => openComposeModal());
    document.getElementById('msg-box-inbox-btn')?.addEventListener('click', () => switchMessageBox('inbox'));
    document.getElementById('msg-box-sent-btn')?.addEventListener('click', () => switchMessageBox('sent'));
    document.getElementById('profile-signature-file')?.addEventListener('change', (e) => uploadAdminDocument(e, 'signature'));
    document.getElementById('profile-stamp-file')?.addEventListener('change', (e) => uploadAdminDocument(e, 'stamp'));
    document.getElementById('profile-school-seal-file')?.addEventListener('change', uploadSchoolSeal);
    document.getElementById('profile-avatar-file')?.addEventListener('change', uploadAdminAvatar);
    document.getElementById('profile-id-photo-file')?.addEventListener('change', uploadAdminIdPhoto);
    document.getElementById('msg-box-teachers-btn')?.addEventListener('click', () => switchMessageBox('teachers'));
    document.getElementById('ar-load-btn')?.addEventListener('click', loadAnalysisReport);
    document.getElementById('ar-print-btn')?.addEventListener('click', printAnalysisReport);

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
    loadTopbarSemester(); // topbar chip lives outside any single page, so refresh it unconditionally
    renderTopbarAcademicYear();
    const active = document.querySelector('.page-content.active');
    if (active) {
        const page = active.id.replace('page-', '');
        const loaders = {
            dashboard: loadDashboard, textbooks: loadTextbooks, absence: loadAbsenceTabs,
            teachers: loadTeacherLeaderboard,
            'teacher-setup': loadTeacherSetup, 'teacher-assignments': loadTeacherAssignments,
            'marks-review': loadMarksReview, 'mark-cutoff': loadMarkCutoffPage, semester: loadSemesterStatus,
            'escalated-absence': loadEscalatedAbsence, disciplinary: loadDisciplinaryCases,
            'teacher-audit': loadTeacherAudit,
            'subject-entry-requests': loadSubjectEntryRequests,
            'dropout-requests': loadDropoutRequests,
            'analysis-report': loadAnalysisReport,
            'document-approvals': loadDocumentApprovals, recognition: loadRecognition,
            'class-leaderboard': loadClassLeaderboard, students: loadStudents,
            messages: () => (CURRENT_MESSAGE_BOX === 'teachers' ? loadContactThreads() : loadMessages(CURRENT_MESSAGE_BOX || 'inbox')),
            'id-card': () => (adminIdCardData ? renderAdminIdCard(adminIdCardData) : loadAdminIdCard())
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
    widgets.push(renderEthCalendarWidget());

    try {
        const studentStatsRes = await apiFetch(`${API_BASE}/api/student-stats`);
        if (studentStatsRes.ok) {
            const s = await studentStatsRes.json();
            const sub = `<span class="stat-sub-item">${lucideIcon('mars', 14)} ${s.male || 0}</span><span class="stat-sub-item">${lucideIcon('venus', 14)} ${s.female || 0}</span>`;
            stats.push(statCard(lucideIcon('users'), t('sa_stat_total_students'), s.total, '', null, sub));
        }

        if (CURRENT_TITLE === 'Admin VP') {
            const [pendingAbsenceRes, textbooksRes] = await Promise.all([
                apiFetch(`${API_BASE}/api/admin/teacher-absence-requests`),
                apiFetch(`${API_BASE}/api/admin/textbooks`)
            ]);
            const pendingAbsence = pendingAbsenceRes.ok ? await pendingAbsenceRes.json() : [];
            const textbooks = textbooksRes.ok ? await textbooksRes.json() : { log: [] };
            const lostCount = (textbooks.log || []).filter(r => r.status === 'lost').length;

            stats.push(statCard(lucideIcon('clipboard-list'), t('sa_stat_pending_teacher_absence'), pendingAbsence.length, pendingAbsence.length > 0 ? 'warning' : ''));
            stats.push(statCard(lucideIcon('book-x'), t('sa_stat_lost_textbooks'), lostCount, lostCount > 0 ? 'danger' : ''));
            loadAlertsDropdown();
        }

        if (CURRENT_TITLE === 'Academic VP') {
            const [termRes, marksRes] = await Promise.all([
                apiFetch(`${API_BASE}/api/term/current`),
                apiFetch(`${API_BASE}/api/academic-vp/marks-review`)
            ]);
            const term = termRes.ok ? await termRes.json() : {};
            const marks = marksRes.ok ? await marksRes.json() : [];
            const notPushed = marks.filter(m => !m.pushed).length;

            stats.push(statCard(lucideIcon('calendar'), t('sa_stat_current_term'), term.current_term || '—', ''));
            stats.push(statCard(lucideIcon('send'), t('sa_stat_homerooms_not_pushed'), notPushed, notPushed > 0 ? 'warning' : 'success'));
            loadAlertsDropdown();
        }

        if (CURRENT_TITLE === 'Principal') {
            const [escalatedRes, casesRes, docsRes, leaveRes, perfRes, lastSemesterRes] = await Promise.all([
                apiFetch(`${API_BASE}/api/principal/teacher-absence-requests`),
                apiFetch(`${API_BASE}/api/principal/disciplinary-cases`),
                apiFetch(`${API_BASE}/api/principal/teacher-document-requests`),
                apiFetch(`${API_BASE}/api/principal/students-on-leave`),
                apiFetch(`${API_BASE}/api/principal/school-performance`),
                apiFetch(`${API_BASE}/api/principal/last-semester-performance`)
            ]);
            const escalated = escalatedRes.ok ? await escalatedRes.json() : [];
            const cases = casesRes.ok ? await casesRes.json() : [];
            const docs = docsRes.ok ? await docsRes.json() : [];
            const onLeave = leaveRes.ok ? await leaveRes.json() : [];
            const performance = perfRes.ok ? await perfRes.json() : null;
            const lastSemester = lastSemesterRes.ok ? await lastSemesterRes.json() : null;
            STUDENTS_ON_LEAVE_CACHE = onLeave;

            const currentlyOnLeave = onLeave.filter(r => r.currently_on_leave).length;

            stats.push(statCard(lucideIcon('triangle-alert'), t('sa_stat_escalated_absence'), escalated.length, escalated.length > 0 ? 'danger' : ''));
            stats.push(statCard(lucideIcon('shield-alert'), t('sa_stat_pending_cases'), cases.length, cases.length > 0 ? 'danger' : ''));
            stats.push(statCard(lucideIcon('signature'), t('sa_stat_pending_documents'), docs.length, docs.length > 0 ? 'warning' : ''));
            stats.push(statCard(lucideIcon('plane-takeoff'), t('sa_stat_students_on_leave'), currentlyOnLeave, '', 'openStudentsOnLeaveModal()'));

            // Bell badge + dropdown contents — shared logic in
            // loadAlertsDropdown() so the count here always matches what
            // clicking the bell actually shows.
            loadAlertsDropdown();

            // School Performance — four angles: academic marks, student
            // attendance (present/excused/unexcused), teacher attendance
            // (same split), and teacher class coverage (periods actually
            // taught vs missed) — all over the trailing 30 school days.
            if (performance) {
                const chartBlock = (heading, hint, slices, total) => total > 0 ? `
                    <div class="widget chart-widget">
                        <h3>${heading}</h3>
                        ${hint ? `<p class="form-hint" style="margin-top:-8px;">${hint}</p>` : ''}
                        ${renderPieChart(slices, 150)}
                    </div>` : '';

                const a = performance.academic || {};
                widgets.push(chartBlock(t('sa_widget_school_performance'), null, [
                    { label: t('sa_perf_good'), value: a.good, color: 'var(--success)' },
                    { label: t('sa_perf_average'), value: a.average, color: 'var(--warning)' },
                    { label: t('sa_perf_poor'), value: a.poor, color: 'var(--danger)' },
                    { label: t('sa_perf_none'), value: a.none, color: 'var(--muted)' }
                ], a.total));

                const sa = performance.student_attendance || {};
                widgets.push(chartBlock(t('sa_widget_student_attendance'), t('sa_perf_window_hint'), [
                    { label: t('sa_att_present'), value: sa.present, color: 'var(--success)' },
                    { label: t('sa_att_excused'), value: sa.excused, color: 'var(--info)' },
                    { label: t('sa_att_unexcused'), value: sa.unexcused, color: 'var(--danger)' }
                ], (sa.present || 0) + (sa.excused || 0) + (sa.unexcused || 0)));

                const ta = performance.teacher_attendance || {};
                widgets.push(chartBlock(t('sa_widget_teacher_attendance'), t('sa_perf_window_hint'), [
                    { label: t('sa_att_present'), value: ta.present, color: 'var(--success)' },
                    { label: t('sa_att_excused'), value: ta.excused, color: 'var(--info)' },
                    { label: t('sa_att_unexcused'), value: ta.unexcused, color: 'var(--danger)' }
                ], (ta.present || 0) + (ta.excused || 0) + (ta.unexcused || 0)));

                const cc = performance.class_coverage || {};
                widgets.push(chartBlock(t('sa_widget_class_coverage'), t('sa_perf_window_hint'), [
                    { label: t('sa_coverage_taught'), value: cc.taught, color: 'var(--success)' },
                    { label: t('sa_coverage_missed'), value: cc.missed, color: 'var(--danger)' }
                ], (cc.taught || 0) + (cc.missed || 0)));
            }

            // Last Semester Performance — a frozen snapshot of the four
            // charts above, taken the moment the previous semester was
            // closed (see POST /api/term/close on the server). Principal-
            // only, read-only: it doesn't recalculate, so it keeps showing
            // exactly what the school looked like when that semester ended
            // even after the live widgets above have reset for the new term.
            if (lastSemester) {
                const lsChartBlock = (heading, slices, total) => total > 0 ? `
                    <div class="widget chart-widget">
                        <h3>${heading}</h3>
                        ${renderPieChart(slices, 120)}
                    </div>` : '';

                const la = lastSemester.academic || {};
                const lsa = lastSemester.student_attendance || {};
                const lta = lastSemester.teacher_attendance || {};
                const lcc = lastSemester.class_coverage || {};

                const archivedDate = lastSemester.archived_at ? formatEthDate(lastSemester.archived_at) : '';
                widgets.push(`
                    <div class="widget" style="grid-column: 1 / -1;">
                        <h3>${t('sa_widget_last_semester')}
                            <span class="badge badge-none">${escapeHtml(lastSemester.term || '')}</span>
                        </h3>
                        <p class="form-hint" style="margin-top:-8px;">${t('sa_last_semester_hint')} ${archivedDate ? `(${archivedDate})` : ''}</p>
                        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:12px;">
                            ${lsChartBlock(t('sa_widget_school_performance'), [
                                { label: t('sa_perf_good'), value: la.good, color: 'var(--success)' },
                                { label: t('sa_perf_average'), value: la.average, color: 'var(--warning)' },
                                { label: t('sa_perf_poor'), value: la.poor, color: 'var(--danger)' },
                                { label: t('sa_perf_none'), value: la.none, color: 'var(--muted)' }
                            ], la.total)}
                            ${lsChartBlock(t('sa_widget_student_attendance'), [
                                { label: t('sa_att_present'), value: lsa.present, color: 'var(--success)' },
                                { label: t('sa_att_excused'), value: lsa.excused, color: 'var(--info)' },
                                { label: t('sa_att_unexcused'), value: lsa.unexcused, color: 'var(--danger)' }
                            ], (lsa.present || 0) + (lsa.excused || 0) + (lsa.unexcused || 0))}
                            ${lsChartBlock(t('sa_widget_teacher_attendance'), [
                                { label: t('sa_att_present'), value: lta.present, color: 'var(--success)' },
                                { label: t('sa_att_excused'), value: lta.excused, color: 'var(--info)' },
                                { label: t('sa_att_unexcused'), value: lta.unexcused, color: 'var(--danger)' }
                            ], (lta.present || 0) + (lta.excused || 0) + (lta.unexcused || 0))}
                            ${lsChartBlock(t('sa_widget_class_coverage'), [
                                { label: t('sa_coverage_taught'), value: lcc.taught, color: 'var(--success)' },
                                { label: t('sa_coverage_missed'), value: lcc.missed, color: 'var(--danger)' }
                            ], (lcc.taught || 0) + (lcc.missed || 0))}
                        </div>
                    </div>`);
            }

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

// Small inline-SVG Lucide icon set. Returns markup with no fixed
// color — it uses stroke="currentColor" so it always matches whatever
// text color its container (e.g. .stat-icon) is styled with.
const LUCIDE_PATHS = {
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'shield-alert': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    signature: '<path d="m21 17-2.156-1.868A.5.5 0 0 0 18 15.5v.5a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1c0-2.545-3.991-3.97-8.5-4a1 1 0 0 0 0 5c4.153 0 4.745-11.295 5.708-13.5a2.5 2.5 0 1 1 3.31 3.284"/><path d="M3 21h18"/>',
    'plane-takeoff': '<path d="M2 22h20"/><path d="M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.17.1a2 2 0 0 0 1.8 0L8 12 5 6l.9-.45a2 2 0 0 1 2.09.2l4.02 3a2 2 0 0 0 2.1.2l4.19-2.06a2.41 2.41 0 0 1 1.73-.17L21 7a1.4 1.4 0 0 1 .87 1.99l-.38.76c-.23.46-.6.84-1.07 1.08L7.58 17.2a2 2 0 0 1-1.22.18Z"/>',
    'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    'circle-x': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    'trending-up': '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
    'book-x': '<path d="m14.5 7-5 5"/><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="m9.5 7 5 5"/>',
    'clipboard-list': '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
    calendar: '<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>',
    'calendar-days': '<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    venus: '<path d="M12 15v7"/><path d="M9 19h6"/><circle cx="12" cy="9" r="6"/>',
    mars: '<path d="M16 3h5v5"/><path d="m21 3-6.75 6.75"/><circle cx="10" cy="14" r="6"/>',
    award: '<path d="m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"/><circle cx="12" cy="8" r="6"/>',
    'log-out': '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
    menu: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
    search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
    bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
    camera: '<path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/><circle cx="12" cy="13" r="3"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    'book-open': '<path d="M12 5v16"/><path d="M20.001 19A2 2 0 0 0 22 17V5a2 2 0 0 0-1.999-2L16 3.002A5 5 0 0 0 12 5a5 5 0 0 0-4-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 1.999 2H8a5 5 0 0 1 4 2 5 5 0 0 1 4-2z"/>'
};
// ---------- Ethiopian calendar helpers (shared across the whole app) ----------
// Every date shown anywhere in the portal should go through this, so the
// Ethiopian calendar is primary and the Gregorian date rides along in
// brackets, per school policy. Falls back to the plain ISO string if the
// date is missing/invalid, or if ethiopian-calendar.js failed to load.
function formatEthDate(dateInput) {
    if (!dateInput) return '—';
    if (typeof EthCal === 'undefined') return dateInput;
    const arg = (dateInput instanceof Date) ? dateInput : String(dateInput).slice(0, 10);
    try {
        return EthCal.formatWithGC(arg, { lang: getCurrentLang(), gcLabel: t('sa_eth_cal_gc') });
    } catch {
        return dateInput;
    }
}

// Same idea, but for a from→to range: only prints the "(GC: ...)" once at
// the end so two adjacent Ethiopian dates don't each carry their own
// bracket, which reads noisily in a table cell.
function formatEthDateRange(fromStr, toStr) {
    if (!fromStr && !toStr) return '—';
    if (typeof EthCal === 'undefined') return `${fromStr || ''} → ${toStr || ''}`;
    const lang = getCurrentLang();
    const gcLabel = t('sa_eth_cal_gc');
    try {
        const fromEth = EthCal.formatWithGC(String(fromStr).slice(0, 10), { lang, ethOnly: true });
        const toEth = toStr ? EthCal.formatWithGC(String(toStr).slice(0, 10), { lang, ethOnly: true }) : null;
        const fromGC = EthCal.formatWithGC(String(fromStr).slice(0, 10), { lang, gcOnly: true });
        const toGC = toStr ? EthCal.formatWithGC(String(toStr).slice(0, 10), { lang, gcOnly: true }) : null;
        if (!toEth || toEth === fromEth) return `${fromEth} (${gcLabel}: ${fromGC})`;
        return `${fromEth} → ${toEth} (${gcLabel}: ${fromGC} → ${toGC})`;
    } catch {
        return `${fromStr || ''} → ${toStr || ''}`;
    }
}

// Timestamp variant — Ethiopian calendar date (GC in brackets) plus the
// clock time, for message threads and "last updated" style fields.
function formatEthDateTime(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${formatEthDate(d)} · ${timeStr}`;
}

// Dashboard widget: today's Ethiopian date + a running list of upcoming
// Ethiopian public holidays (fixed ones computed from the Ethiopian
// calendar itself so they're always correct; movable lunar/Easter ones
// come from EthCal's small reference table — see ethiopian-calendar.js).
function renderEthCalendarWidget() {
    if (typeof EthCal === 'undefined') return '';
    const lang = getCurrentLang();
    const now = new Date();
    const eth = EthCal.toEthiopian(now);
    if (!eth) return '';
    const weekday = EthCal.weekdayName(now, lang);
    const gcStr = now.toLocaleDateString(lang === 'am' ? 'en-GB' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const upcoming = EthCal.getUpcomingHolidays(now, 6);
    const rows = upcoming.length > 0 ? upcoming.map(h => {
        const label = h.daysAway === 0 ? t('sa_eth_cal_today_bang')
            : h.daysAway === 1 ? t('sa_eth_cal_tomorrow')
            : t('sa_eth_cal_in_days', { n: h.daysAway });
        const gDateStr = h.date.toLocaleDateString(lang === 'am' ? 'en-GB' : 'en-US', { month: 'short', day: 'numeric' });
        return `
            <div class="eth-holiday-row">
                <div class="eth-holiday-date-chip">${gDateStr}</div>
                <div class="eth-holiday-info">
                    <div class="eth-holiday-name">${t(h.key)}${h.tentative ? ` <span class="eth-holiday-tentative">(${t('sa_eth_cal_tentative')})</span>` : ''}</div>
                </div>
                <div class="eth-holiday-countdown">${label}</div>
            </div>`;
    }).join('') : `<div class="widget-empty">${t('sa_eth_cal_no_upcoming')}</div>`;

    return `
        <div class="widget eth-cal-widget">
            <h3><span class="eth-cal-title">${lucideIcon('calendar-days', 18)} ${t('sa_eth_cal_widget_title')}</span></h3>
            <div class="eth-cal-today">
                <div class="eth-cal-today-eth">${eth.day} ${EthCal.monthName(eth.month, lang)} ${eth.year}</div>
                <div class="eth-cal-today-meta">${weekday} · ${t('sa_eth_cal_gc')}: ${gcStr}</div>
            </div>
            <div class="eth-cal-holidays-heading">${t('sa_eth_cal_upcoming_holidays')}</div>
            <div class="eth-holiday-list">${rows}</div>
        </div>`;
}

function lucideIcon(name, size = 22) {
    const paths = LUCIDE_PATHS[name] || '';
    return `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function statCard(icon, label, value, tone, onclick, sub) {
    return `<div class="stat-card ${tone ? 'stat-' + tone : ''}" ${onclick ? `style="cursor:pointer" onclick="${onclick}"` : ''}>
        <div class="stat-icon">${icon}</div>
        <div>
            <div class="stat-label">${label}</div>
            <div class="stat-value">${value}</div>
            ${sub ? `<div class="stat-sub-row">${sub}</div>` : ''}
        </div>
    </div>`;
}

// Small dependency-free donut chart: layers one <circle> per slice on the
// same radius, each rotated to where the previous slice left off, using
// stroke-dasharray/offset to draw just its share of the circumference.
// No charting library needed for a handful of slices like this.
function renderPieChart(slices, size = 140) {
    const total = slices.reduce((sum, s) => sum + (s.value || 0), 0);
    const strokeWidth = Math.round(size * 0.15);
    const radius = size / 2 - strokeWidth / 2 - 4;
    const circumference = 2 * Math.PI * radius;
    const center = size / 2;
    // A small visual gap between slices so they read as distinct
    // segments instead of one solid ring when several are non-zero.
    const gapCount = slices.filter(s => s.value > 0).length;
    const gap = gapCount > 1 ? 5 : 0;
    let offsetSoFar = 0;

    const arcs = total === 0 ? '' : slices.filter(s => s.value > 0).map(s => {
        const fraction = s.value / total;
        const rawDash = fraction * circumference;
        const dash = Math.max(rawDash - gap, 0);
        const pct = Math.round(fraction * 100);
        const circle = `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${s.color}"
            stroke-width="${strokeWidth}" stroke-linecap="round"
            stroke-dasharray="${dash} ${circumference - dash}"
            stroke-dashoffset="${-offsetSoFar}" transform="rotate(-90 ${center} ${center})"
            class="donut-slice"><title>${escapeHtml(s.label)}: ${s.value} (${pct}%)</title></circle>`;
        offsetSoFar += rawDash;
        return circle;
    }).join('');

    const legend = slices.map(s => {
        const pct = total > 0 ? Math.round(((s.value || 0) / total) * 100) : 0;
        return `
        <div class="chart-legend-row">
            <span class="chart-legend-dot" style="background:${s.color};"></span>
            <span class="chart-legend-label">${escapeHtml(s.label)}</span>
            <span class="chart-legend-value">${s.value ?? 0}</span>
            <span class="chart-legend-pct">${pct}%</span>
        </div>`;
    }).join('');

    return `
        <div class="chart-flex">
            <div class="donut-wrap" style="width:${size}px; height:${size}px;">
                <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="donut-svg">
                    <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="var(--bg)" stroke-width="${strokeWidth}"></circle>
                    ${total === 0 ? '' : arcs}
                </svg>
                <div class="donut-center-label">
                    <div class="donut-center-value">${total}</div>
                    <div class="donut-center-caption">${t('sa_chart_total_label')}</div>
                </div>
            </div>
            <div class="chart-legend">${legend}</div>
        </div>`;
}

// Principal's "students currently/recently on leave" dashboard modal —
// school-wide, covering both homeroom-approved and Academic-VP-escalated
// approvals alike (see /api/principal/students-on-leave).
function openStudentsOnLeaveModal() {
    const rows = STUDENTS_ON_LEAVE_CACHE || [];
    const rowsHtml = rows.length === 0
        ? `<div class="widget-empty">${t('sa_no_data')}</div>`
        : `<div class="data-table-wrap"><table class="data-table">
            <thead><tr>
                <th>${t('sa_col_student')}</th>
                <th>${t('sa_col_class')}</th>
                <th>${t('sa_col_dates')}</th>
                <th>${t('sa_col_status')}</th>
            </tr></thead>
            <tbody>${rows.map(r => `
                <tr>
                    <td>${escapeHtml([r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '))} (${r.student_id})</td>
                    <td>${escapeHtml(r.class_level)}-${escapeHtml(r.section)}${r.stream ? ' (' + escapeHtml(r.stream) + ')' : ''}</td>
                    <td>${formatEthDateRange(r.date_from, r.date_to)}</td>
                    <td><span class="badge ${r.currently_on_leave ? 'badge-pending' : 'badge-none'}">${r.currently_on_leave ? t('sa_currently_on_leave') : t('sa_leave_completed')}</span></td>
                </tr>`).join('')}</tbody>
        </table></div>`;

    openModal(`
        <h3>${t('sa_students_on_leave_heading')}</h3>
        <p class="form-hint">${t('sa_students_on_leave_hint')}</p>
        ${rowsHtml}
        <div class="form-actions"><button class="btn btn-ghost" onclick="closeModal()">${t('sa_close')}</button></div>
    `);
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
            ${statCard(lucideIcon('circle-check'), t('sa_present_count'), data.present_count, 'success')}
            ${statCard(lucideIcon('circle-x'), t('sa_absent_count'), data.absent_count, data.absent_count > 0 ? 'danger' : '')}
            ${statCard(lucideIcon('trending-up'), t('sa_punctuality_rate'), data.punctuality_rate != null ? data.punctuality_rate + '%' : '—', '')}
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
            <div class="stat-icon">${lucideIcon('book-open')}</div>
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
    const decision = await showChoiceModal(t('sa_prompt_penalty_decision'), [
        { value: 'waived', label: t('sa_penalty_waived'), className: 'btn-success' },
        { value: 'charged', label: t('sa_penalty_charged'), className: 'btn-danger' }
    ]);
    if (!decision) return;
    let amount = null;
    if (decision === 'charged') {
        amount = await showPromptModal(t('sa_prompt_penalty_amount'), { multiline: false, required: true });
        if (amount === null) return;
    }
    const note = await showPromptModal(t('sa_prompt_penalty_note')) || '';
    const res = await apiFetch(`${API_BASE}/api/admin/textbooks/penalty`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id, subject_id, decision, amount, note })
    });
    await handleJsonResponse(res, t('sa_penalty_recorded'));
    loadTextbooks();
}

// ==========================================================
// ABSENCE REQUESTS (Admin VP: teacher only — student escalations moved to
// Academic VP, see loadStudentAbsenceEscalations below)
// ==========================================================
function loadAbsenceTabs() {
    loadTeacherAbsenceRequests();
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
            <td>${formatEthDateRange(r.date_from, r.date_to)}</td>
            <td>${escapeHtml(r.reason || '—')}</td>
            <td>
                <button class="btn btn-sm btn-success" onclick="decideTeacherAbsence(${r.request_id}, 'approve', 'admin')">${t('sa_approve')}</button>
                <button class="btn btn-sm btn-danger" onclick="decideTeacherAbsence(${r.request_id}, 'reject', 'admin')">${t('sa_reject')}</button>
            </td>
        </tr>`).join('');
}

// Escalated student absence requests (Academic VP) — a homeroom teacher's
// approval authority is capped; anything longer lands here instead.
// Approving here surfaces the student on the Principal's "students on
// leave" dashboard widget for the duration of the approved dates.
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
            <td>${formatEthDateRange(r.date_from, r.date_to)}</td>
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
        const reason = await showPromptModal(t('sa_prompt_rejection_reason')) || '';
        body = { reason };
    }
    const res = await apiFetch(`${API_BASE}${base}/${request_id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    await handleJsonResponse(res, t('sa_done'));
    if (scope === 'principal') loadEscalatedAbsence(); else loadTeacherAbsenceRequests();
    if (typeof loadAlertsDropdown === 'function') loadAlertsDropdown();
}

async function decideStudentAbsence(request_id, action) {
    let body = {};
    if (action === 'reject') {
        const reason = await showPromptModal(t('sa_prompt_rejection_reason')) || '';
        body = { reason };
    }
    const res = await apiFetch(`${API_BASE}/api/admin/absence-requests/${request_id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    await handleJsonResponse(res, t('sa_done'));
    loadStudentAbsenceEscalations();
    if (typeof loadAlertsDropdown === 'function') loadAlertsDropdown();
}

// ==========================================================
// TIMETABLE (Academic VP)
// ==========================================================
// Class/section options come from the Registrar's own Section Setup
// (class_sections table, same source the Subject & Teaching Assignment
// page uses) — so Class Level/Section here can only ever be a
// combination the Registrar actually configured. Subjects come from this
// school's own Subject Configuration grid (ticked from the zone/TDC
// subject dictionary), filtered to the selected stream.
let TT_CLASS_SECTIONS_CACHE = [];
let TT_SUBJECTS_CACHE = [];

async function initTimetablePage() {
    const [sectionsRes, subjectsRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/academic-vp/class-sections`),
        apiFetch(`${API_BASE}/api/academic-vp/subjects`)
    ]);
    TT_CLASS_SECTIONS_CACHE = sectionsRes.ok ? await sectionsRes.json() : [];
    TT_SUBJECTS_CACHE = subjectsRes.ok ? await subjectsRes.json() : [];

    const levelSelect = document.getElementById('tt-class-level');
    if (levelSelect) {
        const levels = [...new Set(TT_CLASS_SECTIONS_CACHE.map(s => String(s.class_level)))]
            .sort((a, b) => Number(a) - Number(b));
        const current = levelSelect.value;
        levelSelect.innerHTML = `<option value="">${t('sa_select_class_level')}</option>`
            + levels.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
        if (levels.includes(current)) levelSelect.value = current;
    }
    renderTtSectionOptions();
    refreshTimetableSubjectOptions();
    refreshTimetableTeacherDisplay();
}

// Section dropdown narrows to whatever the Registrar actually set up for
// the selected Class Level (and Stream, once Grade 11/12 picks one) —
// same normalizeStreamCode() bridge used by the Teaching Assignment page,
// since the Registrar's own form stores stream as free text.
function renderTtSectionOptions() {
    const sectionSelect = document.getElementById('tt-section');
    if (!sectionSelect) return;
    const level = document.getElementById('tt-class-level')?.value || '';
    const stream = document.getElementById('tt-stream')?.value || '';
    if (!level) {
        sectionSelect.innerHTML = `<option value="">${t('sa_select_section')}</option>`;
        return;
    }
    let sections = TT_CLASS_SECTIONS_CACHE.filter(s => String(s.class_level) === String(level));
    if (stream) sections = sections.filter(s => !s.stream || normalizeStreamCode(s.stream) === normalizeStreamCode(stream));
    const names = [...new Set(sections.map(s => s.section_name))].sort();
    const current = sectionSelect.value;
    sectionSelect.innerHTML = `<option value="">${t('sa_select_section')}</option>`
        + names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    if (names.includes(current)) sectionSelect.value = current;
}

// Subjects narrow to the selected stream, same rule as the Teaching
// Assignment form: a subject configured for "All Streams" (stream = null)
// always shows, on top of whichever specific stream is chosen. The
// Academic VP never types a subject here — it's only ever one they've
// already ticked in Subject Configuration (sourced from the zone/TDC
// subject dictionary).
function refreshTimetableSubjectOptions() {
    const subjectSelect = document.getElementById('tt-subject-id');
    if (!subjectSelect) return;
    const level = document.getElementById('tt-class-level')?.value || '';
    const stream = document.getElementById('tt-stream')?.value || '';
    if (!level) {
        subjectSelect.innerHTML = `<option value="">${t('sa_tt_select_class_section_first')}</option>`;
        return;
    }
    const list = stream
        ? TT_SUBJECTS_CACHE.filter(s => !s.stream || s.stream === stream)
        : TT_SUBJECTS_CACHE;
    const current = subjectSelect.value;
    subjectSelect.innerHTML = list.length
        ? (`<option value="">${t('sa_select_subject')}</option>` +
           list.map(s => `<option value="${s.subject_id}">${escapeHtml(s.subject_name)}${s.stream ? ' (' + escapeHtml(s.stream) + ')' : ''}</option>`).join(''))
        : `<option value="">${t('sa_no_subject_for_stream')}</option>`;
    if (list.some(s => s.subject_id === current)) subjectSelect.value = current;
}

// Teacher is never typed in — it's whoever is already linked (via the
// Teaching Assignment page) to teach the selected subject in the selected
// class/section. Purely a display lookup; the actual teacher_id used when
// the slot is saved is resolved server-side from the same data.
async function refreshTimetableTeacherDisplay() {
    const display = document.getElementById('tt-teacher-display');
    if (!display) return;
    const class_level = document.getElementById('tt-class-level')?.value || '';
    const section = document.getElementById('tt-section')?.value || '';
    const subject_id = document.getElementById('tt-subject-id')?.value || '';
    if (!class_level || !section || !subject_id) {
        display.classList.add('is-empty');
        display.textContent = t('sa_tt_teacher_placeholder');
        return;
    }
    display.classList.add('is-empty');
    display.textContent = t('sa_loading');
    const res = await apiFetch(`${API_BASE}/api/academic-vp/teacher-assignments?class_level=${encodeURIComponent(class_level)}&section=${encodeURIComponent(section)}&subject_id=${encodeURIComponent(subject_id)}`);
    const rows = res.ok ? await res.json() : [];
    if (rows.length === 0) {
        display.classList.add('is-empty');
        display.textContent = t('sa_tt_teacher_none');
    } else {
        display.classList.remove('is-empty');
        display.textContent = rows[0].teacher_name;
    }
}

// ---------- Ethiopian clock-time display ----------
// Ethiopia runs a 12-hour clock offset 6 hours from the standard/GC clock
// (07:00 standard = 1:00 Ethiopian morning, 13:00 standard = 7:00
// Ethiopian day, etc.) — a fixed, non-negotiable offset, not a timezone
// conversion. Storage/comparison (start_time < end_time, etc.) all stay on
// the standard 24-hour value the <input type="time"> already gives; this
// only computes a friendly Ethiopian-time label alongside it.
function toEthiopianTimeLabel(hhmm) {
    if (!hhmm) return '';
    const [hStr, mStr] = hhmm.split(':');
    const h = Number(hStr), m = Number(mStr);
    if (Number.isNaN(h) || Number.isNaN(m)) return '';
    let ethHour = (h - 6 + 24) % 12;
    if (ethHour === 0) ethHour = 12;
    const isDay = h >= 6 && h < 18;
    const period = isDay ? t('sa_eth_time_day') : t('sa_eth_time_night');
    return `${ethHour}:${String(m).padStart(2, '0')} ${period}`;
}

function showEthiopianTimeHint(hintElId, hhmm) {
    const el = document.getElementById(hintElId);
    if (!el) return;
    const label = toEthiopianTimeLabel(hhmm);
    el.textContent = label ? `${t('sa_eth_time_label')}: ${label}` : '';
}

async function loadTimetable() {
    const class_level = document.getElementById('tt-class-level').value.trim();
    const section = document.getElementById('tt-section').value.trim();
    const stream = document.getElementById('tt-stream').value.trim();
    const tbody = document.getElementById('sa-timetable-tbody');
    if (!class_level || !section || !stream) return showToast(t('sa_err_class_fields_required'), 'error');
    tbody.innerHTML = `<tr><td colspan="6">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/admin/timetable?class_level=${encodeURIComponent(class_level)}&section=${encodeURIComponent(section)}&stream=${encodeURIComponent(stream)}`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    const dayNames = ['', t('sa_monday'), t('sa_tuesday'), t('sa_wednesday'), t('sa_thursday'), t('sa_friday')];
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${dayNames[r.day_of_week] || r.day_of_week}</td>
            <td>${r.start_time} - ${r.end_time}</td>
            <td>${toEthiopianTimeLabel(r.start_time)} - ${toEthiopianTimeLabel(r.end_time)}</td>
            <td>${escapeHtml(r.subject_name)}</td>
            <td>${r.teacher_name ? escapeHtml(r.teacher_name) : '—'}</td>
            <td><button class="btn btn-sm btn-danger" onclick="deleteTimetableSlot(${r.timetable_id})">${t('sa_delete')}</button></td>
        </tr>`).join('');
}

async function addTimetableSlot() {
    const class_level = document.getElementById('tt-class-level').value.trim();
    const section = document.getElementById('tt-section').value.trim();
    const stream = document.getElementById('tt-stream').value.trim();
    const day_of_week = document.getElementById('tt-day').value;
    const subject_id = document.getElementById('tt-subject-id').value.trim();
    const start_time = document.getElementById('tt-start-time').value;
    const end_time = document.getElementById('tt-end-time').value;
    if (!class_level || !section || !stream || !subject_id || !start_time || !end_time) {
        return showToast(t('sa_err_slot_fields_required'), 'error');
    }
    // teacher_id is deliberately not sent — the server resolves it from
    // whoever is actually assigned to teach this subject in this section.
    const res = await apiFetch(`${API_BASE}/api/admin/timetable`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ class_level, section, stream, day_of_week: Number(day_of_week), subject_id, start_time, end_time })
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
            <td>${r.pushed_at ? formatEthDateTime(r.pushed_at) : '—'}</td>
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

// Starting or closing the semester is a whole-school action (it resets the
// attendance-counting clock, freezes marks, etc.), so it re-locks behind
// the Academic VP's own login password first — same one-time re-auth gate
// as unlocking Subject Configuration for edit (verify-password doesn't
// issue a new session, it just confirms the password again).
async function verifyAcademicVpPassword(promptMessage) {
    const password = await showPasswordPromptModal(promptMessage);
    if (!password) return false;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/subjects/verify-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || t('sa_incorrect_password'), 'error');
        return false;
    }
    return true;
}

async function startSemester() {
    if (!(await verifyAcademicVpPassword(t('sa_semester_start_password_prompt')))) return;
    const term = document.getElementById('semester-term-select').value;
    const res = await apiFetch(`${API_BASE}/api/term/set`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ term })
    });
    await handleJsonResponse(res, t('sa_semester_started'));
    loadSemesterStatus();
    loadTopbarSemester();
}

async function closeSemester() {
    if (!(await verifyAcademicVpPassword(t('sa_semester_close_password_prompt')))) return;
    const res = await apiFetch(`${API_BASE}/api/term/close`, { method: 'POST' });
    await handleJsonResponse(res, t('sa_semester_closed'));
    loadSemesterStatus();
    loadTopbarSemester();
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
            <td>${formatEthDateRange(r.date_from, r.date_to)}</td>
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
    if (decision === 'terminated' && !(await showConfirmModal(t('sa_confirm_terminate'), { danger: true }))) return;
    const note = await showPromptModal(t('sa_prompt_decision_note')) || '';
    const res = await apiFetch(`${API_BASE}/api/principal/disciplinary-cases/${case_id}/decide`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note })
    });
    await handleJsonResponse(res, t('sa_case_decided'));
    loadDisciplinaryCases();
    if (typeof loadAlertsDropdown === 'function') loadAlertsDropdown();
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
    if (action === 'reject') body = { reason: await showPromptModal(t('sa_prompt_rejection_reason')) || '' };
    const res = await apiFetch(`${API_BASE}/api/principal/teacher-document-requests/${request_id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    await handleJsonResponse(res, t('sa_done'));
    loadDocumentApprovals();
    if (typeof loadAlertsDropdown === 'function') loadAlertsDropdown();
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
    SCHOOL_LEADERBOARD_DATA = data; // keep the Students > Class Leaderboard tab in sync
    const ranked = (data.ranked || []).slice(0, 15);

    const topFemaleRow = document.getElementById('sa-recognition-top-female-row');
    if (topFemaleRow) {
        const tf = (data.top_female || [])[0];
        const tm = (data.top_male || [])[0];
        topFemaleRow.innerHTML = [
            tf
                ? statCard(lucideIcon('award'), t('sa_top_female_student'), `${escapeHtml(tf.full_name || tf.student_id)} — ${tf.year_average}`, 'accent')
                : statCard(lucideIcon('award'), t('sa_top_female_student'), '—', ''),
            tm
                ? statCard(lucideIcon('award'), t('sa_top_male_student'), `${escapeHtml(tm.full_name || tm.student_id)} — ${tm.year_average}`, 'accent')
                : statCard(lucideIcon('award'), t('sa_top_male_student'), '—', '')
        ].join('');
    }

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

// ==========================================================
// TOP-PERFORMING TEACHERS (Principal / Academic VP / Admin VP)
// ==========================================================
async function loadTeacherLeaderboard() {
    const tbody = document.getElementById('sa-teacher-leaderboard-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/school/teacher-leaderboard`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (!rows || rows.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map((r, i) => `
        <tr>
            <td>#${i + 1}</td>
            <td>${escapeHtml(r.full_name)}</td>
            <td>${r.punctuality_rate != null ? r.punctuality_rate + '%' : '—'}</td>
            <td>${r.absent_days_30d}</td>
        </tr>`).join('');
}

// ==========================================================
// SUBJECT ENTRY REQUESTS (Academic VP) — a homeroom teacher asking to
// enter marks for another subject, usually because that subject's own
// teacher is unavailable. See the matching backend comment on
// subject_entry_requests for the full picture.
// ==========================================================
async function loadSubjectEntryRequests() {
    const tbody = document.getElementById('sa-subject-entry-requests-tbody');
    tbody.innerHTML = `<tr><td colspan="6">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/subject-entry-requests`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (!rows || rows.length === 0) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td><a href="#" onclick="openTeacherAuditModal('${r.teacher_id}'); return false;">${escapeHtml([r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '))}</a></td>
            <td>${escapeHtml(r.subject_name)}</td>
            <td>${escapeHtml(r.class_level)}-${escapeHtml(r.section)}${r.stream ? ` (${escapeHtml(r.stream)})` : ''}</td>
            <td>${escapeHtml(r.reason || '—')}</td>
            <td>${formatEthDate(r.requested_at)}</td>
            <td>
                <button class="btn btn-sm btn-accent" onclick="decideSubjectEntryRequest(${r.id}, 'approve')">${t('sa_approve')}</button>
                <button class="btn btn-sm btn-ghost" onclick="decideSubjectEntryRequest(${r.id}, 'reject')">${t('sa_reject')}</button>
            </td>
        </tr>`).join('');
}

async function decideSubjectEntryRequest(id, action) {
    let body = {};
    if (action === 'reject') body = { reason: await showPromptModal(t('sa_prompt_rejection_reason')) || '' };
    const res = await apiFetch(`${API_BASE}/api/academic-vp/subject-entry-requests/${id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    await handleJsonResponse(res, t('sa_done'));
    loadSubjectEntryRequests();
}

// ==========================================================
// DROPOUT REQUESTS (Academic VP) — a homeroom teacher flagging a
// student as dropped out for the current term. Approving here is what
// actually marks the student Dropped and puts them in the Analysis
// Report's Drop Out count; rejecting sends them back to Active.
// ==========================================================
async function loadDropoutRequests() {
    const tbody = document.getElementById('sa-dropout-requests-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/dropout-requests`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (!rows || rows.length === 0) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.full_name || r.student_id)}</td>
            <td>${escapeHtml(r.class_level)}-${escapeHtml(r.section)}${r.stream ? ` (${escapeHtml(r.stream)})` : ''}</td>
            <td>${escapeHtml(r.reason || '—')}</td>
            <td>${formatEthDate(r.flagged_at)}</td>
            <td>
                <button class="btn btn-sm btn-accent" onclick="decideDropoutRequest('${r.student_id}', 'approve')">${t('sa_approve')}</button>
                <button class="btn btn-sm btn-ghost" onclick="decideDropoutRequest('${r.student_id}', 'reject')">${t('sa_reject')}</button>
            </td>
        </tr>`).join('');
}

async function decideDropoutRequest(student_id, action) {
    if (action === 'approve' && !(await showConfirmModal(t('sa_dropout_approve_confirm')))) return;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/dropout-requests/${student_id}/${action}`, { method: 'POST' });
    await handleJsonResponse(res, action === 'approve' ? t('sa_dropout_approved_msg') : t('sa_dropout_rejected_msg'));
    loadDropoutRequests();
}

// ==========================================================
// SEMESTER / YEARLY ANALYSIS REPORT (Principal / Academic VP / Admin VP)
// ==========================================================
const AR_CATS = ['total_student', 'drop_out', 'tested', 'incomplete', 'band_0_49', 'band_50_74', 'band_75_100'];

async function loadAnalysisReport() {
    const tbody = document.getElementById('sa-analysis-report-tbody');
    const term = document.getElementById('ar-term-select')?.value || 'Year';

    // Only the Principal's account has a signature/seal on file to sign
    // the PDF with (see /api/principal/analysis-report/pdf on the
    // server) — Academic VP and Admin VP can view this same data above,
    // but the print button would just 403 for them, so hide it instead
    // of leaving a button that looks broken.
    const printBtn = document.getElementById('ar-print-btn');
    const printNote = document.getElementById('ar-print-note');
    const isPrincipal = CURRENT_TITLE === 'Principal';
    if (printBtn) printBtn.style.display = isPrincipal ? '' : 'none';
    if (printNote) printNote.style.display = isPrincipal ? 'none' : '';

    tbody.innerHTML = `<tr><td colspan="23">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/principal/analysis-report?term=${encodeURIComponent(term)}`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="23">${t('sa_load_error')}</td></tr>`; return; }
    const data = await res.json();
    const rowHtml = (r, isTotal) => `
        <tr ${isTotal ? 'style="font-weight:bold;background:var(--bg-subtle,#f7f7f7);"' : ''}>
            <td>${escapeHtml(String(r.class_level))}</td>
            ${AR_CATS.map(k => `<td>${r[k].male}</td><td>${r[k].female}</td><td>${r[k].total}</td>`).join('')}
            <td>${r.highest_rank_male}</td>
            <td>${r.highest_rank_female}</td>
        </tr>`;
    if (!data.rows || data.rows.length === 0) { tbody.innerHTML = `<tr><td colspan="23">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = data.rows.map(r => rowHtml(r, false)).join('') + rowHtml(data.totals, true);
}

function printAnalysisReport() {
    const term = document.getElementById('ar-term-select')?.value || 'Year';
    window.open(`${API_BASE}/api/principal/analysis-report/pdf?term=${encodeURIComponent(term)}`, '_blank');
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
let SCHOOL_LEADERBOARD_DATA = null;
const GRADUATED_OR_TRANSFERRED = s => s.status === 'Graduated' || String(s.status || '').startsWith('Transferred');

async function loadStudents() {
    const tbody = document.getElementById('sa-students-tbody');
    tbody.innerHTML = `<tr><td colspan="6">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/students`);
    if (res.ok) {
        ALL_STUDENTS = await res.json();
        populateStudentFilterOptions();
        filterStudentsTable();
    } else {
        tbody.innerHTML = `<tr><td colspan="6">${t('sa_load_error')}</td></tr>`;
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
    const uniq = key => [...new Set(ALL_STUDENTS.map(s => s[key]).filter(Boolean))]
        .sort((a, b) => (isNaN(a) || isNaN(b)) ? String(a).localeCompare(String(b)) : a - b);
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
            statCard(lucideIcon('users'), t('sa_stat_total_students'), total, ''),
            statCard(lucideIcon('mars'), t('sa_stat_male_students'), male, ''),
            statCard(lucideIcon('venus'), t('sa_stat_female_students'), female, '')
        ].join('');
    }
    if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = list.map(s => `
        <tr>
            <td>${s.student_id}</td>
            <td>${escapeHtml([s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' '))}</td>
            <td>${escapeHtml(s.class_level ?? '—')}</td>
            <td>${escapeHtml(s.section ?? '—')}</td>
            <td>${escapeHtml(s.stream ?? '—')}</td>
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
    if (classVal) list = list.filter(s => String(s.class_level) === String(classVal));
    if (sectionVal) list = list.filter(s => String(s.section) === String(sectionVal));
    if (streamVal) list = list.filter(s => String(s.stream) === String(streamVal));
    renderStudentsTable(list);
}

// ---------- Class Leaderboard (General, visible to Principal/Admin VP/Academic VP) ----------
// Shows who's leading a given class/section/stream, by term average —
// filtered client-side from the same school-wide ranking the
// Recognition Awards page uses, so it's always consistent with that
// ranking.
function populateLeaderboardFilterOptions() {
    const classSel = document.getElementById('lb-class-filter');
    const sectionSel = document.getElementById('lb-section-filter');
    const streamSel = document.getElementById('lb-stream-filter');
    if (!classSel) return;
    const uniq = key => [...new Set(ALL_STUDENTS.map(s => s[key]).filter(Boolean))]
        .sort((a, b) => (isNaN(a) || isNaN(b)) ? String(a).localeCompare(String(b)) : a - b);
    const buildOptions = (sel, values, allLabelKey) => {
        const current = sel.value;
        sel.innerHTML = `<option value="">${t(allLabelKey)}</option>` + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
        sel.value = current;
    };
    buildOptions(classSel, uniq('class_level'), 'sa_all_classes');
    buildOptions(sectionSel, uniq('section'), 'sa_all_sections');
    if (streamSel) buildOptions(streamSel, uniq('stream'), 'sa_all_streams');
}

// Same rule as updateStreamOptionsForLevel above (Grade 9/10 = General
// only, Grade 11/12 = Natural or Social), adapted for this filter: an
// "All Streams" option stays available here since narrowing to a
// specific stream is optional, not required like on a registration
// form. Called whenever the Class filter changes.
function updateLeaderboardStreamFilterForClass() {
    const classSel = document.getElementById('lb-class-filter');
    const streamSel = document.getElementById('lb-stream-filter');
    if (!classSel || !streamSel) return;
    const level = classSel.value;
    if (level === '9' || level === '10') {
        streamSel.innerHTML = `<option value="General">${t('sa_stream_general')}</option>`;
        streamSel.value = 'General';
        streamSel.disabled = true;
    } else if (level === '11' || level === '12') {
        streamSel.innerHTML = `
            <option value="">${t('sa_all_streams')}</option>
            <option value="Natural">${t('sa_stream_natural')}</option>
            <option value="Social">${t('sa_stream_social')}</option>`;
        streamSel.value = '';
        streamSel.disabled = false;
    } else {
        // "All Classes" — restore the full set of real stream values
        // actually present in the school's data.
        streamSel.disabled = false;
        const uniq = [...new Set(ALL_STUDENTS.map(s => s.stream).filter(Boolean))].sort();
        streamSel.innerHTML = `<option value="">${t('sa_all_streams')}</option>` + uniq.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
        streamSel.value = '';
    }
}

async function loadClassLeaderboard() {
    const tbody = document.getElementById('sa-class-leaderboard-tbody');
    if (!tbody) return;

    if (ALL_STUDENTS.length === 0) {
        const sres = await apiFetch(`${API_BASE}/api/students`);
        if (sres.ok) ALL_STUDENTS = await sres.json();
    }
    populateLeaderboardFilterOptions();

    if (!SCHOOL_LEADERBOARD_DATA) {
        tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
        const res = await apiFetch(`${API_BASE}/api/principal/school-leaderboard`);
        if (!res.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
        SCHOOL_LEADERBOARD_DATA = await res.json();
    }
    renderClassLeaderboard();
}

function renderClassLeaderboard() {
    const tbody = document.getElementById('sa-class-leaderboard-tbody');
    if (!tbody) return;
    const classVal = document.getElementById('lb-class-filter')?.value || '';
    const sectionVal = document.getElementById('lb-section-filter')?.value || '';
    const streamVal = document.getElementById('lb-stream-filter')?.value || '';
    if (!classVal && !sectionVal && !streamVal) {
        tbody.innerHTML = `<tr><td colspan="4">${t('sa_leaderboard_pick_class')}</td></tr>`;
        return;
    }
    let list = (SCHOOL_LEADERBOARD_DATA?.ranked || []);
    if (classVal) list = list.filter(r => String(r.class_level) === String(classVal));
    if (sectionVal) list = list.filter(r => String(r.section) === String(sectionVal));
    if (streamVal) list = list.filter(r => String(r.stream) === String(streamVal));
    list = [...list].sort((a, b) => (a.rank ?? 999999) - (b.rank ?? 999999));
    if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = list.map(r => `
        <tr>
            <td>#${r.rank}</td>
            <td>${escapeHtml(r.full_name || r.student_id)}</td>
            <td>${r.class_level}-${r.section}</td>
            <td>${r.year_average}</td>
        </tr>`).join('');
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
                : (r.status === 'cleared'
                    ? `<span class="badge badge-approved">${t('sa_transfer_done')}</span>`
                    : '—')}</td>
        </tr>`).join('');
}

// Principal enters a student ID and transfers them out directly — no
// student-submitted request needed. Skips straight to 'approved' so it
// shows up ready for the Registrar to clear and issue a transfer code.
async function initiateDirectTransfer() {
    const input = document.getElementById('direct-transfer-student-id');
    const student_id = input.value.trim();
    if (!student_id) return showToast(t('sa_err_student_id_required'), 'error');

    const res = await apiFetch(`${API_BASE}/api/principal/transfer-requests/direct`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id })
    });
    const data = await handleJsonResponse(res, t('sa_transfer_initiated'));
    if (!data) return;
    input.value = '';
    loadTransferRequests();
    loadStudents();
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
    const reason = await showPromptModal(t('sa_decline_reason_prompt')) || '';
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
            <td>${formatEthDate(r.completed_at || r.initiated_at)}</td>
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
        <div class="form-actions"><button class="btn btn-ghost" onclick="closeModal()">${t('sa_close')}</button></div>`, 'modal-box-wide');
    const res = await apiFetch(`${API_BASE}/api/principal/graduation-batches/${encodeURIComponent(batch)}`);
    const body = document.getElementById('batch-modal-body');
    if (!body) return;
    if (!res.ok) { body.innerHTML = t('sa_load_error'); return; }
    const students = await res.json();
    body.innerHTML = `
        <div class="data-table-wrap">
            <table class="data-table">
                <thead><tr><th>${t('sa_col_student_id')}</th><th>${t('sa_col_name')}</th><th>${t('sa_col_class')}</th><th>${t('sa_col_stream')}</th></tr></thead>
                <tbody>${students.map(s => `
                    <tr><td>${s.student_id}</td><td>${escapeHtml(s.full_name)}</td><td>${s.class_level}-${s.section}</td><td>${escapeHtml(s.stream ?? '—')}</td></tr>
                `).join('')}</tbody>
            </table>
        </div>`;
}

// ---------- Shared: class level -> stream dependency ----------
// Grade 9 & 10 only ever run "General" (no stream split yet); Grade 11 &
// 12 split into Natural or Social Science. Used by the Timetable form and
// the Subject & Teaching Assignment / Homeroom forms alike.
// No blank "Select stream..." placeholder for 11/12 anymore — a
// placeholder step here just adds an extra click and confused people, so
// the dropdown now always lands on a real choice (Natural, first) the
// moment the class level is picked; switching to Social is one click away.
function updateStreamOptionsForLevel(streamSelect, level) {
    if (!streamSelect) return;
    if (level === '9' || level === '10') {
        streamSelect.innerHTML = `<option value="General">${t('sa_stream_general')}</option>`;
        streamSelect.value = 'General';
        streamSelect.disabled = true;
    } else if (level === '11' || level === '12') {
        streamSelect.innerHTML = `
            <option value="Natural">${t('sa_stream_natural')}</option>
            <option value="Social">${t('sa_stream_social')}</option>`;
        streamSelect.value = 'Natural';
        streamSelect.disabled = false;
    } else {
        streamSelect.innerHTML = `<option value="">${t('sa_select_class_level')}</option>`;
        streamSelect.value = '';
        streamSelect.disabled = true;
    }
}

// ---------- Shared: search-and-pick a teacher by ID or name ----------
// Backs the "Teacher ID" lookup boxes in Subject & Teaching Assignment and
// Assign Homeroom — type or search, click a match, it's selected. Reads
// from TA_TEACHERS_CACHE (populated by loadTeacherAssignments) so it works
// offline of any extra network round-trip.
function wireTeacherSearch(inputId, btnId, resultsId, hiddenId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    const results = document.getElementById(resultsId);
    const hidden = document.getElementById(hiddenId);
    if (!input || !results || !hidden) return;

    const runSearch = () => {
        const q = input.value.trim().toLowerCase();
        hidden.value = '';
        if (!q) { results.innerHTML = ''; return; }
        const matches = (TA_TEACHERS_CACHE || []).filter(tr =>
            tr.teacher_id.toLowerCase().includes(q) || tr.full_name.toLowerCase().includes(q));
        if (matches.length === 0) {
            results.innerHTML = `<div class="form-hint">${t('sa_teacher_search_no_match')}</div>`;
            return;
        }
        results.innerHTML = matches.slice(0, 8).map(tr => `
            <div class="badge badge-none" style="cursor:pointer; margin:2px 4px 2px 0; display:inline-block;"
                 data-teacher-id="${escapeHtml(tr.teacher_id)}" data-teacher-name="${escapeHtml(tr.full_name)}">
                ${escapeHtml(tr.full_name)} (${tr.teacher_id})
            </div>`).join('');
        // Delegated listeners on the freshly-rendered badges, rather than
        // an inline onclick string — a teacher's full_name traveling
        // through JSON.stringify() straight into a double-quoted onclick
        // attribute would embed a raw " and silently corrupt/truncate the
        // handler for every single result, which is exactly why clicking
        // a suggestion did nothing.
        results.querySelectorAll('[data-teacher-id]').forEach(el => {
            el.addEventListener('click', () => {
                selectTeacherFromSearch(inputId, resultsId, hiddenId, el.dataset.teacherId, el.dataset.teacherName);
            });
        });
    };

    btn?.addEventListener('click', runSearch);
    input.addEventListener('input', runSearch);
}

function selectTeacherFromSearch(inputId, resultsId, hiddenId, teacher_id, full_name) {
    document.getElementById(hiddenId).value = teacher_id;
    document.getElementById(inputId).value = '';
    document.getElementById(resultsId).innerHTML = `
        <div class="form-hint">${t('sa_teacher_selected_prefix')} ${escapeHtml(full_name)} (${teacher_id})
            <button type="button" class="btn btn-sm btn-ghost" onclick="document.getElementById('${hiddenId}').value=''; document.getElementById('${resultsId}').innerHTML='';">${t('sa_teacher_change')}</button>
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
            <input type="text" id="accept-incoming-password" value="1122" />
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
    const reason = await showPromptModal(t('sa_decline_reason_prompt')) || '';
    const res = await apiFetch(`${API_BASE}/api/principal/incoming-teachers/${incoming_id}/decline`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason })
    });
    await handleJsonResponse(res, t('sa_incoming_declined'));
    loadIncomingTeachers();
}

// ==========================================================
// TEACHING ASSIGNMENTS, Stage 2 (Academic VP)
// ==========================================================
let TA_TEACHERS_CACHE = [];
let TA_SUBJECTS_CACHE = [];

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
    TA_SUBJECTS_CACHE = subjectsRes.ok ? await subjectsRes.json() : [];

    // Teacher pickers are now search-and-select (by Teacher ID or name)
    // rather than a plain dropdown — see wireTeacherSearch(). Just make
    // sure a stale selection from a teacher no longer in this school's
    // roster gets cleared.
    ['ta-teacher-select', 'hr-teacher-select'].forEach(id => {
        const hidden = document.getElementById(id);
        if (hidden && hidden.value && !teachers.some(tr => tr.teacher_id === hidden.value)) hidden.value = '';
    });

    refreshAssignmentSubjectOptions();
    if (canAssign) { loadSubjectConfig(); loadClassSectionsForAssignment(); }

    const filterSelect = document.getElementById('ta-filter-teacher');
    if (filterSelect) {
        const currentValue = filterTeacherId || filterSelect.value || '';
        filterSelect.innerHTML = `<option value="">${t('sa_ta_all_teachers')}</option>` +
            teachers.map(tr => `<option value="${tr.teacher_id}">${escapeHtml(tr.full_name)} (${tr.teacher_id})</option>`).join('');
        filterSelect.value = currentValue;
    }

    const tbody = document.getElementById('sa-teacher-assignments-tbody');
    tbody.innerHTML = `<tr><td colspan="6">${t('sa_loading')}</td></tr>`;
    const teacherIdFilter = filterTeacherId || filterSelect?.value || '';
    const url = teacherIdFilter
        ? `${API_BASE}/api/academic-vp/teacher-assignments?teacher_id=${encodeURIComponent(teacherIdFilter)}`
        : `${API_BASE}/api/academic-vp/teacher-assignments`;
    const res = await apiFetch(url);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.teacher_name)}</td>
            <td>${escapeHtml(r.subject_name)}</td>
            <td>${escapeHtml(r.class_level)}</td>
            <td>${escapeHtml(r.section)}</td>
            <td>${escapeHtml(r.stream ?? '—')}</td>
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
    if (!teacher_id) return showToast(t('sa_err_teacher_not_selected'), 'error');
    if (!class_level || !section) return showToast(t('sa_err_assignment_required'), 'error');

    const res = await apiFetch(`${API_BASE}/api/academic-vp/homeroom`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id, class_level, section, stream: stream || null })
    });
    const data = await handleJsonResponse(res, t('sa_homeroom_assigned'));
    if (!data) return;
    document.getElementById('hr-teacher-select').value = '';
    document.getElementById('hr-teacher-search-results').innerHTML = '';
    document.getElementById('hr-class-level').value = '';
    document.getElementById('hr-section').value = '';
    updateStreamOptionsForLevel(document.getElementById('hr-stream'), '');
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
    if (!(await showConfirmModal(t('sa_grant_registrar_confirm')))) return;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/grant-registrar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id })
    });
    await handleJsonResponse(res, t('sa_registrar_granted'));
    loadTeacherAssignments();
}

async function revokeRegistrar(teacher_id) {
    if (!(await showConfirmModal(t('sa_revoke_registrar_confirm'), { danger: true }))) return;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/grant-registrar`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id })
    });
    await handleJsonResponse(res, t('sa_registrar_revoked'));
    loadTeacherAssignments();
}

// Classes/sections actually configured by the Registrar (class_sections
// table) — replaces the old hardcoded "9/10/11/12" and "A/B/C/D" options
// in Class Level and Section, so Academic VP can only ever pick a
// combination that really exists at this school.
let TA_CLASS_SECTIONS_CACHE = [];

async function loadClassSectionsForAssignment() {
    const res = await apiFetch(`${API_BASE}/api/academic-vp/class-sections`);
    TA_CLASS_SECTIONS_CACHE = res.ok ? await res.json() : [];

    const levelSelect = document.getElementById('ta-class-level');
    if (levelSelect) {
        const levels = [...new Set(TA_CLASS_SECTIONS_CACHE.map(s => String(s.class_level)))]
            .sort((a, b) => Number(a) - Number(b));
        const current = levelSelect.value;
        levelSelect.innerHTML = `<option value="">${t('sa_select_class_level')}</option>`
            + levels.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
        if (levels.includes(current)) levelSelect.value = current;
    }
    renderTaSectionCheckboxes();
}

// The Registrar's own Section Setup form stores stream as free text
// (e.g. "Natural Science"), while this form's Stream dropdown uses the
// short code ("Natural") that the rest of the app (subjects, teacher
// assignments) is built around. Same class_sections.stream column, two
// different spellings — normalize both sides before comparing so a
// section the Registrar configured under "Natural Science" still shows
// up once "Natural" is picked here.
function normalizeStreamCode(raw) {
    const s = (raw || '').toLowerCase();
    if (s.startsWith('natural')) return 'Natural';
    if (s.startsWith('social')) return 'Social';
    if (s.startsWith('general')) return 'General';
    return raw || '';
}

// Renders the Section tick-list for whatever Class Level (and, for
// Grade 11/12, Stream) is currently picked — ticking A, C, and D but
// leaving B unticked assigns the teacher to those three sections in one
// submit (see saveTeacherAssignment below), instead of one dropdown pick
// at a time.
function renderTaSectionCheckboxes() {
    const box = document.getElementById('ta-section-checkboxes');
    if (!box) return;
    const level = document.getElementById('ta-class-level')?.value || '';
    const stream = document.getElementById('ta-stream')?.value || '';
    if (!level) {
        box.innerHTML = `<span class="form-hint" data-i18n="sa_select_class_level_first">${t('sa_select_class_level_first')}</span>`;
        return;
    }
    let sections = TA_CLASS_SECTIONS_CACHE.filter(s => String(s.class_level) === String(level));
    if (stream) sections = sections.filter(s => !s.stream || normalizeStreamCode(s.stream) === normalizeStreamCode(stream));
    if (sections.length === 0) {
        box.innerHTML = `<span class="form-hint">${t('sa_no_data')}</span>`;
        return;
    }
    const names = [...new Set(sections.map(s => s.section_name))].sort();
    box.innerHTML = names.map(name => `
        <label><input type="checkbox" class="ta-section-cb" value="${escapeHtml(name)}"> ${escapeHtml(name)}</label>
    `).join('');
}

// Subjects narrow to whatever the currently-selected stream can teach:
// a subject configured for "All Streams" (stream = null) always shows, on
// top of whichever specific stream (General/Natural/Social) is chosen.
function refreshAssignmentSubjectOptions() {
    const subjectSelect = document.getElementById('ta-subject-select');
    if (!subjectSelect) return;
    const stream = document.getElementById('ta-stream')?.value || '';
    const list = stream
        ? TA_SUBJECTS_CACHE.filter(s => !s.stream || s.stream === stream)
        : TA_SUBJECTS_CACHE;
    const current = subjectSelect.value;
    subjectSelect.innerHTML = list.map(s => `<option value="${s.subject_id}">${escapeHtml(s.subject_name)}${s.stream ? ' (' + escapeHtml(s.stream) + ')' : ''}</option>`).join('')
        || `<option value="">${t('sa_no_subject')}</option>`;
    if (list.some(s => s.subject_id === current)) subjectSelect.value = current;
}

async function saveTeacherAssignment() {
    const teacher_id = document.getElementById('ta-teacher-select').value;
    const subject_id = document.getElementById('ta-subject-select').value;
    const class_level = document.getElementById('ta-class-level').value.trim();
    const stream = document.getElementById('ta-stream').value.trim();
    const sections = [...document.querySelectorAll('.ta-section-cb:checked')].map(cb => cb.value);
    if (!teacher_id) return showToast(t('sa_err_teacher_not_selected'), 'error');
    if (!subject_id || !class_level || sections.length === 0) return showToast(t('sa_err_assignment_required'), 'error');

    let successCount = 0;
    const errors = [];
    for (const section of sections) {
        const res = await apiFetch(`${API_BASE}/api/academic-vp/teacher-assignments`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id, subject_id, class_level, section, stream: stream || null })
        });
        if (res.ok) {
            successCount++;
        } else {
            const data = await res.json().catch(() => ({}));
            errors.push(`${section}: ${data.error || res.status}`);
        }
    }
    if (successCount > 0) showToast(t('sa_assignment_saved'), 'success');
    if (errors.length > 0) showToast(errors.join(' · '), 'error');
    document.getElementById('ta-teacher-select').value = '';
    document.getElementById('ta-teacher-search-results').innerHTML = '';
    document.getElementById('ta-class-level').value = '';
    updateStreamOptionsForLevel(document.getElementById('ta-stream'), '');
    renderTaSectionCheckboxes();
    loadTeacherAssignments();
}

// ==========================================================
// SUBJECT CONFIGURATION (Academic VP) — which subjects this school
// actually teaches, tagged by stream, so they surface in the Subject &
// Teaching Assignment form and the Timetable builder.
//
// Shown as a grid: one row per subject in the zone's own subject
// dictionary (set by the Head of Education, see
// /api/zonal/subject-dictionary — a school can't invent a subject name
// here, only tick which of ITS streams already exist in that zone list),
// one checkbox column per stream (General / Natural / Social). The grid
// stays read-only until "Edit" is clicked and the Academic VP re-enters
// their own login password (/api/academic-vp/subjects/verify-password);
// "Save" then bulk-writes the whole grid in one call
// (/api/academic-vp/subjects/bulk-save).
let SUBJ_CONFIG_DICTIONARY = [];   // subject names from the zone dictionary
let SUBJ_CONFIG_EXISTING = [];     // already-configured {subject_id, subject_name, stream} rows
let SUBJ_CONFIG_UNLOCKED = false;

function subjConfigStreamKey(name, stream) {
    return `${name}\u0000${stream}`;
}

function renderSubjectConfigGrid() {
    const tbody = document.getElementById('sa-subject-config-tbody');
    if (!tbody) return;
    // Row set = zone dictionary names, plus any already-configured name
    // that's since dropped out of the dictionary (so it stays visible
    // and editable instead of silently disappearing).
    const dictSet = new Set(SUBJ_CONFIG_DICTIONARY);
    const names = [...new Set([
        ...SUBJ_CONFIG_DICTIONARY,
        ...SUBJ_CONFIG_EXISTING.map(s => s.subject_name)
    ])].sort();
    if (names.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4">${t('sa_no_subject_dictionary')}</td></tr>`;
        updateOrphanedSubjectsUi();
        return;
    }
    const existingSet = new Set(SUBJ_CONFIG_EXISTING.map(s => subjConfigStreamKey(s.subject_name, s.stream)));
    tbody.innerHTML = names.map(name => `
        <tr>
            <td>${escapeHtml(name)}${dictSet.has(name) ? '' : ` <span class="badge badge-pending" title="${escapeHtml(t('sa_subj_not_in_dictionary_title'))}">${t('sa_subj_not_in_dictionary_badge')}</span>`}</td>
            ${['General', 'Natural', 'Social'].map(stream => `
                <td style="text-align:center">
                    <input type="checkbox" class="subj-config-cb"
                        data-subject-name="${escapeHtml(name)}" data-stream="${stream}"
                        ${existingSet.has(subjConfigStreamKey(name, stream)) ? 'checked' : ''}
                        ${SUBJ_CONFIG_UNLOCKED ? '' : 'disabled'}>
                </td>`).join('')}
        </tr>`).join('');
    updateOrphanedSubjectsUi();
}

// Subjects this school has already configured under a name that's no
// longer (or never was, if the dictionary changed after they were added)
// in the zone's subject dictionary — e.g. the TDC renamed or removed the
// entry after this school ticked it. These stay editable in the grid
// (see the row-set comment above) but are otherwise invisible unless
// flagged, so the Academic VP has a way to spot and clear them out in
// one action instead of hunting row by row.
function getOrphanedSubjectNames() {
    const dictSet = new Set(SUBJ_CONFIG_DICTIONARY);
    return [...new Set(SUBJ_CONFIG_EXISTING.map(s => s.subject_name).filter(name => !dictSet.has(name)))].sort();
}

function updateOrphanedSubjectsUi() {
    const btn = document.getElementById('subj-remove-orphaned-btn');
    const hint = document.getElementById('subj-orphaned-hint');
    if (!btn || !hint) return;
    const orphaned = getOrphanedSubjectNames();
    if (orphaned.length === 0) {
        btn.style.display = 'none';
        hint.style.display = 'none';
        return;
    }
    btn.style.display = '';
    hint.style.display = '';
    hint.textContent = t('sa_subj_orphaned_hint', { names: orphaned.join(', ') });
}

async function loadSubjectConfig() {
    const tbody = document.getElementById('sa-subject-config-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="4">${t('sa_loading')}</td></tr>`;
    const [dictRes, subjRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/academic-vp/subject-dictionary`),
        apiFetch(`${API_BASE}/api/academic-vp/subjects`)
    ]);
    if (!subjRes.ok) { tbody.innerHTML = `<tr><td colspan="4">${t('sa_load_error')}</td></tr>`; return; }
    SUBJ_CONFIG_DICTIONARY = dictRes.ok ? await dictRes.json() : [];
    SUBJ_CONFIG_EXISTING = await subjRes.json();
    TA_SUBJECTS_CACHE = SUBJ_CONFIG_EXISTING;
    refreshAssignmentSubjectOptions();
    renderSubjectConfigGrid();
}

// "Edit" re-locks behind the Academic VP's own login password before the
// grid becomes tickable — a lightweight re-auth gate, not a new session.
async function requestSubjectConfigEdit() {
    const password = await showPasswordPromptModal(t('sa_reenter_password_prompt'));
    if (!password) return;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/subjects/verify-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || t('sa_incorrect_password'), 'error');
        return;
    }
    SUBJ_CONFIG_UNLOCKED = true;
    document.getElementById('subj-edit-btn').style.display = 'none';
    document.getElementById('subj-save-btn').style.display = '';
    renderSubjectConfigGrid();
}

async function saveSubjectConfigGrid() {
    const byName = new Map();
    document.querySelectorAll('.subj-config-cb').forEach(cb => {
        const name = cb.dataset.subjectName;
        if (!byName.has(name)) byName.set(name, []);
        if (cb.checked) byName.get(name).push(cb.dataset.stream);
    });
    const config = [...byName.entries()].map(([subject_name, streams]) => ({ subject_name, streams }));

    const res = await apiFetch(`${API_BASE}/api/academic-vp/subjects/bulk-save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || t('sa_save_error'), 'error'); return; }
    if (data.skipped && data.skipped.length > 0) {
        showToast(t('sa_subject_config_partial_save'), 'warning');
    } else {
        showToast(t('sa_subject_config_saved'), 'success');
    }
    SUBJ_CONFIG_UNLOCKED = false;
    document.getElementById('subj-edit-btn').style.display = '';
    document.getElementById('subj-save-btn').style.display = 'none';
    loadSubjectConfig();
}

// One-click cleanup for subjects this school configured under a name
// that's since fallen out of the zone dictionary (renamed/removed by the
// TDC, wrong zone at the time, etc. — see getOrphanedSubjectNames above).
// Reuses the exact same bulk-save endpoint a normal grid Save hits, just
// with every orphaned (subject_name, stream) pair left out of the target
// config — so it gets the same "skip if a teacher is already assigned to
// it" safety net for free, and reported back the same way.
async function removeOrphanedSubjects() {
    const orphaned = getOrphanedSubjectNames();
    if (orphaned.length === 0) return;
    if (!(await showConfirmModal(t('sa_subj_remove_orphaned_confirm', { names: orphaned.join(', ') }), { danger: true }))) return;
    if (!(await verifyAcademicVpPassword(t('sa_reenter_password_prompt')))) return;

    const orphanedSet = new Set(orphaned);
    const byName = new Map();
    for (const s of SUBJ_CONFIG_EXISTING) {
        if (orphanedSet.has(s.subject_name)) continue;
        if (!byName.has(s.subject_name)) byName.set(s.subject_name, []);
        byName.get(s.subject_name).push(s.stream);
    }
    const config = [...byName.entries()].map(([subject_name, streams]) => ({ subject_name, streams }));

    const res = await apiFetch(`${API_BASE}/api/academic-vp/subjects/bulk-save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || t('sa_save_error'), 'error'); return; }
    if (data.skipped && data.skipped.length > 0) {
        showToast(t('sa_subj_orphaned_removed_partial'), 'warning');
    } else {
        showToast(t('sa_subj_orphaned_removed'), 'success');
    }
    loadSubjectConfig();
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
        `<tr><td>${formatEthDate(a.attendance_date)}</td><td><span class="badge badge-${a.status}">${a.status}</span></td></tr>`).join('') ||
        `<tr><td colspan="2">${t('sa_no_data')}</td></tr>`;

    const scoreRows = (d.subject_scores || []).map(s =>
        `<tr><td>${escapeHtml(s.subject_name)}</td><td>${escapeHtml(s.term)}</td><td>${s.avg_score}</td></tr>`).join('') ||
        `<tr><td colspan="3">${t('sa_no_data')}</td></tr>`;

    openModal(`
        <h3>${escapeHtml(d.full_name)} (${d.teacher_id})</h3>
        <div class="stat-row" style="margin-bottom:16px;">
            ${statCard(lucideIcon('circle-x'), t('sa_absent_count'), d.absent_days_30d, d.absent_days_30d > 0 ? 'danger' : '')}
            ${statCard(lucideIcon('trending-up'), t('sa_punctuality_rate'), d.punctuality.rate != null ? d.punctuality.rate + '%' : '—', '')}
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
function openModal(innerHtml, extraClass) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'sa-generic-modal';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    const box = document.createElement('div');
    box.className = extraClass ? `modal-box ${extraClass}` : 'modal-box';
    box.innerHTML = innerHtml;
    overlay.appendChild(box);
    document.getElementById('sa-audit-modal-root').appendChild(overlay);
}
function closeModal() {
    document.getElementById('sa-generic-modal')?.remove();
}

// Styled replacements for the browser's native confirm()/prompt() — same
// visual language as every other modal in the app (modal-overlay/modal-box),
// instead of the unstyled OS-level popup. Each returns a Promise so call
// sites just swap `confirm(msg)` for `await showConfirmModal(msg)` and
// `prompt(msg)` for `await showPromptModal(msg)` with no other changes.
function showConfirmModal(message, { danger = false, confirmLabel, cancelLabel } = {}) {
    return new Promise(resolve => {
        openModal(`
            <h3>${t('sa_confirm_title')}</h3>
            <p style="margin:12px 0 20px;">${escapeHtml(message)}</p>
            <div class="form-actions">
                <button class="btn btn-ghost" id="sa-confirm-cancel-btn">${cancelLabel || t('sa_cancel')}</button>
                <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="sa-confirm-ok-btn">${confirmLabel || t('sa_confirm_ok')}</button>
            </div>`);
        let settled = false;
        const finish = (val) => { if (settled) return; settled = true; closeModal(); resolve(val); };
        document.getElementById('sa-confirm-ok-btn').onclick = () => finish(true);
        document.getElementById('sa-confirm-cancel-btn').onclick = () => finish(false);
        document.getElementById('sa-generic-modal').addEventListener('click', (e) => {
            if (e.target.id === 'sa-generic-modal') finish(false);
        });
    });
}

function showPromptModal(message, { placeholder = '', required = false, multiline = true } = {}) {
    return new Promise(resolve => {
        const field = multiline
            ? `<textarea id="sa-prompt-input-field" class="form-control" rows="3" placeholder="${escapeHtml(placeholder)}" style="width:100%; margin:12px 0;"></textarea>`
            : `<input id="sa-prompt-input-field" class="form-control" type="text" placeholder="${escapeHtml(placeholder)}" style="width:100%; margin:12px 0;">`;
        openModal(`
            <h3>${escapeHtml(message)}</h3>
            ${field}
            <p id="sa-prompt-input-error" class="form-hint" style="color:var(--danger); display:none;">${t('sa_field_required')}</p>
            <div class="form-actions">
                <button class="btn btn-ghost" id="sa-prompt-cancel-btn">${t('sa_cancel')}</button>
                <button class="btn btn-primary" id="sa-prompt-ok-btn">${t('sa_confirm_ok')}</button>
            </div>`);
        const input = document.getElementById('sa-prompt-input-field');
        input.focus();
        let settled = false;
        const finish = (val) => { if (settled) return; settled = true; closeModal(); resolve(val); };
        document.getElementById('sa-prompt-ok-btn').onclick = () => {
            const val = input.value.trim();
            if (required && !val) { document.getElementById('sa-prompt-input-error').style.display = 'block'; return; }
            finish(val);
        };
        document.getElementById('sa-prompt-cancel-btn').onclick = () => finish(null);
        document.getElementById('sa-generic-modal').addEventListener('click', (e) => {
            if (e.target.id === 'sa-generic-modal') finish(null);
        });
    });
}

// Same shape as showPromptModal, but a masked password field — used for
// re-authentication gates like unlocking Subject Configuration for edit.
function showPasswordPromptModal(message) {
    return new Promise(resolve => {
        openModal(`
            <h3>${escapeHtml(message)}</h3>
            <input id="sa-password-prompt-field" class="form-control" type="password" style="width:100%; margin:12px 0;" autocomplete="current-password">
            <div class="form-actions">
                <button class="btn btn-ghost" id="sa-password-prompt-cancel-btn">${t('sa_cancel')}</button>
                <button class="btn btn-primary" id="sa-password-prompt-ok-btn">${t('sa_confirm_ok')}</button>
            </div>`);
        const input = document.getElementById('sa-password-prompt-field');
        input.focus();
        let settled = false;
        const finish = (val) => { if (settled) return; settled = true; closeModal(); resolve(val); };
        const submit = () => finish(input.value);
        document.getElementById('sa-password-prompt-ok-btn').onclick = submit;
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        document.getElementById('sa-password-prompt-cancel-btn').onclick = () => finish(null);
        document.getElementById('sa-generic-modal').addEventListener('click', (e) => {
            if (e.target.id === 'sa-generic-modal') finish(null);
        });
    });
}

// Small set of labeled buttons instead of a free-text prompt, for
// decisions that only make sense as one of a fixed set of values.
function showChoiceModal(message, choices) {
    return new Promise(resolve => {
        openModal(`
            <h3>${escapeHtml(message)}</h3>
            <div class="form-actions" style="flex-wrap:wrap; margin-top:16px;">
                ${choices.map(c => `<button class="btn ${c.className || 'btn-ghost'}" data-choice-value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</button>`).join('')}
                <button class="btn btn-ghost" id="sa-choice-cancel-btn">${t('sa_cancel')}</button>
            </div>`);
        let settled = false;
        const finish = (val) => { if (settled) return; settled = true; closeModal(); resolve(val); };
        document.getElementById('sa-generic-modal').querySelectorAll('[data-choice-value]').forEach(btn => {
            btn.onclick = () => finish(btn.getAttribute('data-choice-value'));
        });
        document.getElementById('sa-choice-cancel-btn').onclick = () => finish(null);
        document.getElementById('sa-generic-modal').addEventListener('click', (e) => {
            if (e.target.id === 'sa-generic-modal') finish(null);
        });
    });
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
        // Zonal Admin Bridge — now a real picker (Head of Education,
        // Team Leaders, Development Coordinators, etc.), defaulting to
        // the Head of Education when there's more than one option.
        const contacts = MESSAGE_RECIPIENTS_CACHE.zonal_contacts || [];
        if (contacts.length > 0) {
            wrap.style.display = '';
            select.innerHTML = contacts.map(x => `<option value="${x.id}" ${MESSAGE_RECIPIENTS_CACHE.zonal_contact?.id === x.id ? 'selected' : ''}>${escapeHtml(x.full_name)}${x.title ? ' (' + escapeHtml(x.title) + ')' : ''}</option>`).join('');
        } else {
            wrap.style.display = 'none';
            select.innerHTML = '';
        }
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
    closeModal();
    if (CURRENT_MESSAGE_BOX === 'sent') loadMessages('sent');
}

// Compose lives in a modal now (opened by the "New Message" button, or by
// Reply pre-filled with the original sender) rather than a fixed widget,
// so the list/detail panes underneath have the full page to themselves.
function openComposeModal(prefill = {}) {
    openModal(`
        <h3 data-i18n="sa_compose_heading">${t('sa_compose_heading')}</h3>
        <div class="form-row">
            <div class="form-group">
                <label data-i18n="sa_recipient_type_label">${t('sa_recipient_type_label')}</label>
                <select id="msg-recipient-type">
                    <option value="teachers" data-i18n="sa_recipient_teacher">${t('sa_recipient_teacher')}</option>
                    <option value="school_admins" data-i18n="sa_recipient_admin">${t('sa_recipient_admin')}</option>
                    <option value="zonal_admins" data-i18n="sa_recipient_zonal">${t('sa_recipient_zonal')}</option>
                </select>
            </div>
            <div class="form-group" id="msg-recipient-picker-wrap">
                <label data-i18n="sa_recipient_label">${t('sa_recipient_label')}</label>
                <select id="msg-recipient-select"></select>
            </div>
        </div>
        <div class="form-group">
            <label data-i18n="sa_subject_label">${t('sa_subject_label')}</label>
            <input type="text" id="msg-subject" />
        </div>
        <div class="form-group">
            <label data-i18n="sa_message_label">${t('sa_message_label')}</label>
            <textarea id="msg-body"></textarea>
        </div>
        <div class="form-actions">
            <button class="btn btn-ghost" onclick="closeModal()" data-i18n="sa_close">${t('sa_close')}</button>
            <button class="btn btn-accent" id="msg-send-btn" data-i18n="sa_send_btn">${t('sa_send_btn')}</button>
        </div>
    `, 'modal-box-wide');

    document.getElementById('msg-recipient-type').addEventListener('change', loadMessageRecipients);
    document.getElementById('msg-send-btn').addEventListener('click', sendAdminMessage);

    loadMessageRecipients().then(() => {
        if (prefill.recipient_type) {
            document.getElementById('msg-recipient-type').value = prefill.recipient_type;
            loadMessageRecipients();
        }
        const recipientSelect = document.getElementById('msg-recipient-select');
        if (prefill.recipient_id) {
            if (![...recipientSelect.options].some(o => o.value === String(prefill.recipient_id))) {
                const opt = document.createElement('option');
                opt.value = prefill.recipient_id;
                opt.textContent = prefill.recipient_id;
                recipientSelect.appendChild(opt);
            }
            recipientSelect.value = prefill.recipient_id;
        }
        if (prefill.subject) document.getElementById('msg-subject').value = prefill.subject;
        document.getElementById('msg-body').focus();
    });
}

function switchMessageBox(box) {
    CURRENT_MESSAGE_BOX = box;
    CURRENT_MESSAGES_CACHE = [];
    SELECTED_MESSAGE_ID = null;
    document.getElementById('msg-box-inbox-btn').classList.toggle('active', box === 'inbox');
    document.getElementById('msg-box-sent-btn').classList.toggle('active', box === 'sent');
    document.getElementById('msg-box-teachers-btn').classList.toggle('active', box === 'teachers');
    document.getElementById('sa-message-detail').innerHTML = `<div class="msg-detail-empty" data-i18n="sa_select_message">${t('sa_select_message')}</div>`;
    if (box === 'teachers') loadContactThreads();
    else loadMessages(box);
}

let CURRENT_MESSAGES_CACHE = [];
let SELECTED_MESSAGE_ID = null;

async function loadMessages(box) {
    CURRENT_MESSAGE_BOX = box;
    const listEl = document.getElementById('sa-messages-list');
    listEl.innerHTML = `<div class="widget-loading">${t('sa_loading')}</div>`;
    const res = await apiFetch(`${API_BASE}/api/admin/messages?box=${box}`);
    if (!res.ok) { listEl.innerHTML = `<div class="widget-empty">${t('sa_load_error')}</div>`; return; }
    const rows = await res.json();
    CURRENT_MESSAGES_CACHE = rows;
    if (rows.length === 0) { listEl.innerHTML = `<div class="widget-empty">${t('sa_no_data')}</div>`; return; }
    listEl.innerHTML = rows.map(m => {
        const name = box === 'inbox' ? m.sender_id : m.recipient_id;
        const unread = !m.is_read && box === 'inbox';
        return `
        <div class="msg-row${unread ? ' unread' : ''}" data-id="${m.message_id}" onclick="selectMessage(${m.message_id})">
            <div class="msg-row-top">
                <span class="msg-row-name">${escapeHtml(name || '—')}</span>
                <span class="msg-row-date">${formatEthDateTime(m.sent_at)}</span>
            </div>
            <div class="msg-row-subject">${escapeHtml(m.subject || t('sa_no_subject'))}</div>
            <div class="msg-row-snippet">${escapeHtml(m.body)}</div>
        </div>`;
    }).join('');
}

// Renders the selected message into the right-hand detail pane, and marks
// it as the visually-active row in the list on the left.
function selectMessage(message_id) {
    SELECTED_MESSAGE_ID = message_id;
    document.querySelectorAll('#sa-messages-list .msg-row').forEach(row => {
        row.classList.toggle('selected', Number(row.dataset.id) === Number(message_id));
    });
    const m = CURRENT_MESSAGES_CACHE.find(x => x.message_id === message_id);
    const detail = document.getElementById('sa-message-detail');
    if (!m) { detail.innerHTML = `<div class="msg-detail-empty">${t('sa_select_message')}</div>`; return; }
    const box = CURRENT_MESSAGE_BOX;
    const name = box === 'inbox' ? m.sender_id : m.recipient_id;
    detail.innerHTML = `
        <div class="msg-detail-header">
            <h3 class="msg-detail-subject">${escapeHtml(m.subject || t('sa_no_subject'))}</h3>
            <div class="msg-detail-meta">${escapeHtml(name || '—')} · ${formatEthDateTime(m.sent_at)}</div>
        </div>
        <div class="msg-detail-body">${escapeHtml(m.body)}</div>
        <div class="msg-detail-actions">
            ${!m.is_read && box === 'inbox' ? `<button class="btn btn-sm btn-ghost" onclick="markMessageRead(${m.message_id})">${t('sa_mark_read')}</button>` : ''}
            ${box === 'inbox' ? `<button class="btn btn-sm btn-primary" onclick="replyToMessage('${m.sender_type}', '${m.sender_id}', ${JSON.stringify(m.subject || '').replace(/"/g, '&quot;')})">${t('sa_reply_btn')}</button>` : ''}
        </div>`;
    if (!m.is_read && box === 'inbox') markMessageRead(message_id);
}

// ---------- "From Teachers" — the Contact School threads teachers send
// to a management role (Principal / Admin VP / Academic VP), addressed
// to this admin's title or cc'ing it ----------
async function loadContactThreads() {
    const listEl = document.getElementById('sa-messages-list');
    listEl.innerHTML = `<div class="widget-loading">${t('sa_loading')}</div>`;
    const res = await apiFetch(`${API_BASE}/api/admin/contact-threads`);
    if (!res.ok) { listEl.innerHTML = `<div class="widget-empty">${t('sa_load_error')}</div>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { listEl.innerHTML = `<div class="widget-empty">${t('sa_no_data')}</div>`; return; }
    listEl.innerHTML = rows.map(th => `
        <div class="msg-row${th.unread_count > 0 ? ' unread' : ''}" onclick="openContactThreadModal(${th.thread_id})">
            <div class="msg-row-top">
                <span class="msg-row-name">${escapeHtml(th.teacher_name)}</span>
                <span class="msg-row-date">${formatEthDateTime(th.updated_at)}</span>
            </div>
            <div class="msg-row-subject">${escapeHtml(th.subject)} ${th.unread_count > 0 ? `<span class="badge badge-rejected">${th.unread_count}</span>` : ''}</div>
            <div class="msg-row-snippet">${escapeHtml(th.category)} ·
                <span class="badge ${th.status === 'Resolved' ? 'badge-closed' : 'badge-open'}">${escapeHtml(th.status)}</span>
            </div>
        </div>`).join('');
    refreshUnreadMessagesBadge();
}

async function openContactThreadModal(thread_id) {
    openModal(`<h3>${t('sa_thread_heading')}</h3><div id="contact-thread-modal-body">${t('sa_loading')}</div>
        <div class="form-actions"><button class="btn btn-ghost" onclick="closeModal()">${t('sa_close')}</button></div>`);
    const res = await apiFetch(`${API_BASE}/api/admin/contact-threads/${thread_id}`);
    const body = document.getElementById('contact-thread-modal-body');
    if (!body) return;
    if (!res.ok) { body.innerHTML = t('sa_load_error'); return; }
    const { thread, messages } = await res.json();
    body.innerHTML = `
        <p class="form-hint">${escapeHtml(thread.category)} — ${t('sa_thread_addressed_to')} ${escapeHtml(thread.recipient_role)}${thread.cc_roles.length ? ` (cc: ${thread.cc_roles.map(escapeHtml).join(', ')})` : ''}</p>
        <div style="max-height:280px; overflow-y:auto; margin-bottom:12px;">
            ${messages.map(m => `
                <div style="padding:8px 10px; margin-bottom:6px; border-radius:8px; background:${m.sender_role === 'teacher' ? '#f7faf8' : 'var(--info-bg)'};">
                    <div class="form-hint">${m.sender_role === 'teacher' ? escapeHtml(thread.teacher_id) : t('sa_you_label')} · ${formatEthDateTime(m.sent_at)}</div>
                    <div>${escapeHtml(m.body)}</div>
                </div>`).join('')}
        </div>
        <div class="form-group">
            <label data-i18n="sa_message_label">${t('sa_message_label')}</label>
            <textarea id="contact-thread-reply-body"></textarea>
        </div>
        <div class="form-actions" style="margin-top:0;">
            <button class="btn btn-accent btn-sm" onclick="replyToContactThread(${thread_id})">${t('sa_reply_btn')}</button>
            <button class="btn ${thread.status === 'Resolved' ? 'btn-ghost' : 'btn-success'} btn-sm" onclick="toggleContactThreadStatus(${thread_id}, '${thread.status === 'Resolved' ? 'Open' : 'Resolved'}')">
                ${thread.status === 'Resolved' ? t('sa_reopen_thread') : t('sa_resolve_thread')}
            </button>
        </div>`;
}

async function replyToContactThread(thread_id) {
    const textarea = document.getElementById('contact-thread-reply-body');
    const body = textarea.value.trim();
    if (!body) return showToast(t('sa_err_message_body_required'), 'error');
    const res = await apiFetch(`${API_BASE}/api/admin/contact-threads/${thread_id}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body })
    });
    const data = await handleJsonResponse(res, t('sa_reply_sent'));
    if (!data) return;
    openContactThreadModal(thread_id);
    loadContactThreads();
}

async function toggleContactThreadStatus(thread_id, status) {
    const res = await apiFetch(`${API_BASE}/api/contact/thread/${thread_id}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
    });
    const data = await handleJsonResponse(res);
    if (!data) return;
    closeModal();
    loadContactThreads();
}

// Anyone can reply to a message sent to them: this pre-fills the compose
// modal with the original sender as the recipient (works for a teacher,
// another school admin, or a zonal admin).
async function replyToMessage(sender_type, sender_id, original_subject) {
    // Reply opens the same compose modal as "New Message", pre-filled with
    // the original sender as the recipient (works for a teacher, another
    // school admin, or a zonal admin — see openComposeModal's prefill args).
    openComposeModal({
        recipient_type: sender_type,
        recipient_id: sender_id,
        subject: original_subject ? `${t('sa_reply_subject_prefix')}${original_subject}` : ''
    });
}

async function markMessageRead(message_id) {
    await apiFetch(`${API_BASE}/api/admin/messages/${message_id}/read`, { method: 'POST' });
    await loadMessages(CURRENT_MESSAGE_BOX);
    if (SELECTED_MESSAGE_ID === message_id) selectMessage(message_id);
    refreshUnreadMessagesBadge();
}

async function refreshUnreadMessagesBadge() {
    const badge = document.getElementById('sa-messages-badge');
    const teacherBadge = document.getElementById('sa-teacher-threads-badge');

    let inboxUnread = 0;
    const res = await apiFetch(`${API_BASE}/api/admin/messages?box=inbox`);
    if (res.ok) inboxUnread = (await res.json()).filter(m => !m.is_read).length;

    let threadsUnread = 0;
    const threadsRes = await apiFetch(`${API_BASE}/api/admin/contact-threads`);
    if (threadsRes.ok) threadsUnread = (await threadsRes.json()).reduce((sum, th) => sum + Number(th.unread_count || 0), 0);

    if (teacherBadge) {
        if (threadsUnread > 0) { teacherBadge.style.display = 'inline-flex'; teacherBadge.textContent = threadsUnread; }
        else teacherBadge.style.display = 'none';
    }

    if (!badge) return;
    const total = inboxUnread + threadsUnread;
    if (total > 0) { badge.style.display = 'inline-flex'; badge.textContent = total; }
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
    if (data.signature_url) {
        sigPreview.src = API_BASE + data.signature_url; sigPreview.style.display = '';
        document.getElementById('profile-signature-placeholder').style.display = 'none';
    }
    if (data.stamp_url) {
        stampPreview.src = API_BASE + data.stamp_url; stampPreview.style.display = '';
        document.getElementById('profile-stamp-placeholder').style.display = 'none';
    }
    const idPhotoPreview = document.getElementById('profile-id-photo-preview');
    if (data.id_photo_url) {
        idPhotoPreview.src = API_BASE + data.id_photo_url; idPhotoPreview.style.display = '';
        document.getElementById('profile-id-photo-placeholder').style.display = 'none';
    }

    // School Seal — a school-wide asset (not tied to any one admin), so
    // everyone sees the same preview, but only the Principal can change
    // it. Everyone else gets a locked dropzone with an explanatory hint.
    const sealPreview = document.getElementById('profile-school-seal-preview');
    if (data.school_seal_url) {
        sealPreview.src = API_BASE + data.school_seal_url; sealPreview.style.display = '';
        document.getElementById('profile-school-seal-placeholder').style.display = 'none';
    }
    const isPrincipal = CURRENT_TITLE === 'Principal';
    const sealCard = document.getElementById('profile-school-seal-card');
    document.getElementById('profile-school-seal-change-btn').style.display = isPrincipal ? '' : 'none';
    document.getElementById('profile-school-seal-locked-hint').style.display = isPrincipal ? 'none' : '';
    if (sealCard) sealCard.querySelector('.doc-upload-dropzone').style.cursor = isPrincipal ? 'pointer' : 'not-allowed';

    if (data.avatar_url) {
        const fullUrl = API_BASE + data.avatar_url;
        const profileImg = document.getElementById('profile-avatar-img');
        profileImg.src = fullUrl; profileImg.style.display = '';
        document.getElementById('profile-avatar-initials-text').style.display = 'none';
        const topbarImg = document.getElementById('sa-avatar-img');
        topbarImg.src = fullUrl; topbarImg.style.display = '';
        document.getElementById('sa-avatar-initials-text').style.display = 'none';
    }
}

async function uploadSchoolSeal(event) {
    if (CURRENT_TITLE !== 'Principal') {
        event.target.value = '';
        showToast(t('sa_school_seal_principal_only'), 'error');
        return;
    }
    const file = event.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('school_seal', file);
    const res = await apiFetch(`${API_BASE}/api/admin/upload-school-seal`, { method: 'POST', body: formData });
    const data = await handleJsonResponse(res, t('sa_school_seal_uploaded'));
    if (!data || !data.school_seal_url) return;
    const preview = document.getElementById('profile-school-seal-preview');
    preview.src = API_BASE + data.school_seal_url; preview.style.display = '';
    document.getElementById('profile-school-seal-placeholder').style.display = 'none';
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
    if (url) {
        preview.src = API_BASE + url; preview.style.display = '';
        document.getElementById(`profile-${kind}-placeholder`).style.display = 'none';
    }
}

// ID card photo — intentionally its own function rather than reusing
// uploadAdminDocument(): the form field name is id_photo (not a plain
// "kind" string), and unlike signature/stamp this also needs to bust the
// in-memory adminIdCardData cache so the ID card page re-fetches the new
// photo instead of showing whatever was cached from the last visit.
async function uploadAdminIdPhoto(event) {
    const file = event.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('id_photo', file);
    const res = await apiFetch(`${API_BASE}/api/admin/upload-id-photo`, { method: 'POST', body: formData });
    const data = await handleJsonResponse(res, t('sa_id_photo_uploaded'));
    if (!data?.id_photo_url) return;
    const preview = document.getElementById('profile-id-photo-preview');
    preview.src = API_BASE + data.id_photo_url; preview.style.display = '';
    document.getElementById('profile-id-photo-placeholder').style.display = 'none';
    adminIdCardData = null;
}

// Profile picture — updates both the profile-page circle and the
// top-bar avatar together so they never fall out of sync. The ID card
// fetches its own copy of avatar_url (see loadAdminIdCard), so clearing
// its cache here just means the next visit to that page picks up the
// new photo instead of showing a stale one.
async function uploadAdminAvatar(event) {
    const file = event.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('avatar', file);
    const res = await apiFetch(`${API_BASE}/api/admin/upload-avatar`, { method: 'POST', body: formData });
    const data = await handleJsonResponse(res, t('sa_avatar_uploaded'));
    if (!data?.avatar_url) return;
    const fullUrl = API_BASE + data.avatar_url;
    const profileImg = document.getElementById('profile-avatar-img');
    profileImg.src = fullUrl; profileImg.style.display = '';
    document.getElementById('profile-avatar-initials-text').style.display = 'none';
    const topbarImg = document.getElementById('sa-avatar-img');
    topbarImg.src = fullUrl; topbarImg.style.display = '';
    document.getElementById('sa-avatar-initials-text').style.display = 'none';
    adminIdCardData = null;
}

// ==========================================================
// MY ID CARD — mirrors the teacher portal's flip-card design
// (purple/gold, front+back, printable, QR-verified) 1:1, just backed by
// /api/admin/id-card instead of /api/teacher/id-card. Fetched once per
// page visit and re-rendered (not re-fetched) on language switch, since
// only the static labels change, not the underlying data.
// ==========================================================
let adminIdCardData = null;

async function loadAdminIdCard() {
    const errorEl = document.getElementById('idcard-error');
    const wrap = document.getElementById('idcard-wrap');
    const actions = document.getElementById('idcard-actions');
    if (!wrap) return;

    if (adminIdCardData) {
        renderAdminIdCard(adminIdCardData);
        return;
    }

    try {
        const res = await apiFetch(`${API_BASE}/api/admin/id-card`);
        if (!res.ok) throw new Error("Could not load ID card");
        const data = await res.json();
        adminIdCardData = data;
        renderAdminIdCard(data);
    } catch (err) {
        console.error("ID card load error:", err);
        if (errorEl) {
            errorEl.textContent = t('sa_idcard_could_not_load');
            errorEl.style.display = 'block';
        }
        if (wrap) wrap.style.display = 'none';
        if (actions) actions.style.display = 'none';
    }
}

function renderAdminIdCard(data) {
    const wrap = document.getElementById('idcard-wrap');
    const actions = document.getElementById('idcard-actions');
    const errorEl = document.getElementById('idcard-error');
    if (!wrap) return;

    if (errorEl) errorEl.style.display = 'none';
    wrap.style.display = 'flex';
    if (actions) actions.style.display = 'flex';

    // Bilingual (English + Amharic together) regardless of the site-wide
    // language switch — this is a printable credential, not a page that
    // should change depending on which tab was last clicked.
    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    const zoneLabel = data.zone ? data.zone.toUpperCase() : '—';
    const woredaLabel = data.woreda || '—';
    setText('idcard-zone-front', zoneLabel);
    setText('idcard-zone-back', zoneLabel);
    setText('idcard-woreda-front', woredaLabel);
    setText('idcard-woreda-back', woredaLabel);
    setText('idcard-school-name-front', data.school_name || '—');
    setText('idcard-name', data.full_name || '—');
    setText('idcard-admin-id', data.admin_id || '—');
    setText('idcard-title-row', data.title || '—');
    setText('idcard-valid-until', data.valid_until || '—');
    setText('idcard-phone', data.contact_number || '—');
    setText('idcard-email', data.email || '—');
    setText('idcard-address', data.school_address || 'Not set / አልተመዘገበም');

    const photo = document.getElementById('idcard-photo');
    const placeholder = document.getElementById('idcard-photo-placeholder');
    if (data.avatar_url && photo) {
        photo.src = API_BASE + data.avatar_url;
        photo.alt = data.full_name ? `Photo of ${data.full_name}` : 'Admin photo';
        photo.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
    } else {
        if (photo) photo.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
    }

    renderIdCardQrCode(data.qr_payload || data.admin_id || '');
}

// Real, scannable QR code encoding the server-signed "<admin_id>.<signature>"
// payload (signQrPayload/verifyQrPayload on the server), same scheme as the
// teacher and student ID/QR flows.
function renderIdCardQrCode(payload) {
    const container = document.getElementById('idcard-qrcode');
    if (!container) return;
    container.innerHTML = '';
    if (typeof qrcode !== 'function' || !payload) return;

    const qr = qrcode(4, 'M');
    qr.addData(String(payload));
    qr.make();
    container.innerHTML = qr.createSvgTag(4, 2);
}

window.flipIdCard = () => {
    const flipper = document.getElementById('idcard-flipper');
    if (flipper) flipper.classList.toggle('idcard-flipped');
};

window.printIdCard = () => {
    window.print();
};