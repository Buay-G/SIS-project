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
        // e.g. school_name "Newland" + school_level "SECONDARY SCHOOL" ->
        // "NEWLAND SECONDARY SCHOOL". Uppercased unconditionally rather
        // than trusting the stored casing of either field, so this is
        // consistent even if a school's name wasn't entered in all caps.
        const schoolDisplayName = [data.school_name, data.school_level].filter(Boolean).join(' ').toUpperCase();

        document.getElementById('sa-school-name').textContent = schoolDisplayName || '—';
        document.getElementById('sa-title-badge').textContent = CURRENT_TITLE;
        document.getElementById('sa-nav-admin-id').textContent = data.user_id || '—';
        document.getElementById('profile-admin-id').textContent = data.user_id || '—';
        document.getElementById('profile-admin-id-2').textContent = data.user_id || '—';
        document.getElementById('profile-title').textContent = CURRENT_TITLE;
        document.getElementById('profile-school-name').textContent = schoolDisplayName || '—';
        document.getElementById('profile-header-name').textContent = displayName;
        document.getElementById('profile-header-title').textContent = CURRENT_TITLE;

        document.getElementById('topbar-school-name').textContent = schoolDisplayName || '—';
        document.getElementById('topbar-moe-code').textContent = data.moe_school_code ? t('sa_topbar_moe', { code: data.moe_school_code }) : t('sa_topbar_moe_unknown');

        // The sidebar badge starts as plain "SA" text (see index.html) —
        // once the zone this school belongs to has a logo on file
        // (uploaded by a super admin via /api/super/zones/:zone_id/logo),
        // that image replaces it here instead.
        const logoBadge = document.getElementById('sa-logo-badge');
        if (logoBadge && data.zone_logo_url) {
            logoBadge.innerHTML = `<img src="${API_BASE}${data.zone_logo_url}" alt="" />`;
        }

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
        // Keep the bell live without needing a page refresh — pending
        // items (a new absence request, a transfer request, etc.) should
        // turn the badge red on their own within a minute of showing up.
        setInterval(loadAlertsDropdown, 60000);
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
                    <button class="btn btn-success" ${actionAttrs('decideTeacherAbsence', [r.request_id, 'approve', 'admin'])}>${t('sa_approve')}</button>
                    <button class="btn btn-danger" ${actionAttrs('decideTeacherAbsence', [r.request_id, 'reject', 'admin'])}>${t('sa_reject')}</button>
                    <button class="btn btn-ghost" ${actionAttrs('navigateToPage', ['absence'])}>${t('sa_view')}</button>`
            }));
        } else if (CURRENT_TITLE === 'Academic VP') {
            const [absRes, dropoutRes] = await Promise.all([
                apiFetch(`${API_BASE}/api/admin/absence-requests`),
                apiFetch(`${API_BASE}/api/academic-vp/dropout-requests`)
            ]);
            const rows = absRes.ok ? await absRes.json() : [];
            const dropouts = dropoutRes.ok ? await dropoutRes.json() : [];

            items = rows.map(r => alertItemHtml({
                title: `${lucideIcon('user', 15)} ${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} (${r.student_id})`,
                meta: `${r.class_level}-${r.section} · ${formatEthDateRange(r.date_from, r.date_to)}`,
                actionsHtml: `
                    <button class="btn btn-success" ${actionAttrs('decideStudentAbsence', [r.request_id, 'approve'])}>${t('sa_approve')}</button>
                    <button class="btn btn-danger" ${actionAttrs('decideStudentAbsence', [r.request_id, 'reject'])}>${t('sa_reject')}</button>
                    <button class="btn btn-ghost" ${actionAttrs('navigateToPage', ['student-absence-escalations'])}>${t('sa_view')}</button>`
            }));
            items = items.concat(dropouts.map(r => alertItemHtml({
                title: `${lucideIcon('user-x', 15)} ${escapeHtml(r.full_name)} (${r.student_id})`,
                meta: `${r.class_level}-${r.section} · ${escapeHtml(r.reason_category || r.reason || '')}`,
                actionsHtml: `<button class="btn btn-ghost" ${actionAttrs('navigateToPage', ['dropout-requests'])}>${t('sa_view')}</button>`
            })));
        } else if (CURRENT_TITLE === 'Principal') {
            const [escRes, casesRes, docsRes, transferRes] = await Promise.all([
                apiFetch(`${API_BASE}/api/principal/teacher-absence-requests`),
                apiFetch(`${API_BASE}/api/principal/disciplinary-cases`),
                apiFetch(`${API_BASE}/api/principal/teacher-document-requests`),
                apiFetch(`${API_BASE}/api/principal/transfer-requests`)
            ]);
            const escalated = escRes.ok ? await escRes.json() : [];
            const cases = casesRes.ok ? await casesRes.json() : [];
            const docs = docsRes.ok ? await docsRes.json() : [];
            const transfers = transferRes.ok ? (await transferRes.json()).filter(r => r.status === 'pending') : [];

            items = escalated.map(r => alertItemHtml({
                title: `${lucideIcon('triangle-alert', 15)} ${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} (${r.teacher_id})`,
                meta: `${t('sa_nav_escalated_absence')}: ${formatEthDateRange(r.date_from, r.date_to)}${r.reason ? ' · ' + escapeHtml(r.reason) : ''}`,
                actionsHtml: `
                    <button class="btn btn-success" ${actionAttrs('decideTeacherAbsence', [r.request_id, 'approve', 'principal'])}>${t('sa_approve')}</button>
                    <button class="btn btn-danger" ${actionAttrs('decideTeacherAbsence', [r.request_id, 'reject', 'principal'])}>${t('sa_reject')}</button>
                    <button class="btn btn-ghost" ${actionAttrs('navigateToPage', ['escalated-absence'])}>${t('sa_view')}</button>`
            }));
            items = items.concat(cases.map(r => alertItemHtml({
                title: `${lucideIcon('shield-alert', 15)} ${escapeHtml(r.full_name || r.student_id)}`,
                meta: escapeHtml(r.description || ''),
                actionsHtml: `<button class="btn btn-ghost" ${actionAttrs('navigateToPage', ['disciplinary'])}>${t('sa_view')}</button>`
            })));
            items = items.concat(docs.map(r => alertItemHtml({
                title: `${lucideIcon('signature', 15)} ${escapeHtml(r.teacher_name)} (${r.teacher_id})`,
                meta: r.doc_type === 'signature' ? t('sa_doc_type_signature') : t('sa_doc_type_id_photo'),
                actionsHtml: `<button class="btn btn-ghost" ${actionAttrs('navigateToPage', ['document-approvals'])}>${t('sa_view')}</button>`
            })));
            items = items.concat(transfers.map(r => alertItemHtml({
                title: `${lucideIcon('arrow-right-left', 15)} ${escapeHtml(r.full_name)} (${r.student_id})`,
                meta: `${r.class_level}-${r.section}${r.reason ? ' · ' + escapeHtml(r.reason) : ''}`,
                actionsHtml: `
                    <button class="btn btn-success" ${actionAttrs('approveTransferRequest', [r.request_id])}>${t('sa_approve')}</button>
                    <button class="btn btn-danger" ${actionAttrs('rejectTransferRequest', [r.request_id])}>${t('sa_reject')}</button>
                    <button class="btn btn-ghost" ${actionAttrs('navigateToPage', ['transfer-requests'])}>${t('sa_view')}</button>`
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
// just simulates a click on the matching sidebar link). Transfer requests
// live as a tab inside the Students page rather than their own nav
// entry, so that case also clicks the matching tab button once the page
// is showing.
function navigateToPage(page) {
    ALERTS_DROPDOWN_OPEN = false;
    document.getElementById('sa-alerts-dropdown').style.display = 'none';
    if (page === 'transfer-requests') {
        document.querySelector(`#sa-nav-menu [data-page="students"]`)?.click();
        document.querySelector(`.tab-btn[data-tab="students-transfer-requests"]`)?.click();
        return;
    }
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

    // Wired here rather than an inline onclick="..." attribute — this
    // portal's CSP (see helmet() in server.js) locks down
    // script-src-attr by default, which silently blocks every inline
    // event handler in the page (this bell included) unless that
    // directive is explicitly relaxed. addEventListener isn't subject
    // to that directive at all, so the bell works regardless of how
    // strict script-src-attr is set.
    document.getElementById('sa-alerts-btn')?.addEventListener('click', toggleAlertsDropdown);

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
            // New page = a different (or absent) .page-sticky-header /
            // .sticky-filter-bar stack above the table, so re-measure —
            // see updateStickyOffsets() for why this can't just be a
            // one-time-at-load calculation.
            updateStickyOffsets();

            // Leaving the Teachers page (or any page) while the QR
            // camera is running would otherwise leave the device's
            // camera light on in the background.
            if (page !== 'teachers') stopTeacherQrScanner();

            const loaders = {
                dashboard: loadDashboard,
                'teacher-setup': loadTeacherSetup,
                teachers: () => { loadTeacherLeaderboard(); loadTeacherAttendanceToday(); },
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
        const confirmed = await showConfirmModal(t('sa_logout_confirm_msg'), {
            danger: true,
            confirmLabel: t('sa_logout'),
            cancelLabel: t('sa_cancel')
        });
        if (!confirmed) return;
        try { await apiFetch(`${API_BASE}/api/logout`, { method: 'POST' }); } catch {}
        window.location.href = '/login.html';
    });

    // Wire up all the action buttons once, up front
    document.getElementById('mark-attendance-btn')?.addEventListener('click', markTeacherAttendance);
    initTeacherQrScanner();
    document.getElementById('punctuality-lookup-btn')?.addEventListener('click', lookupPunctuality);
    document.getElementById('grant-leave-btn')?.addEventListener('click', grantTeacherLeave);
    document.getElementById('tt-class-level')?.addEventListener('change', (e) => {
        updateStreamOptionsForLevel(document.getElementById('tt-stream'), e.target.value);
        renderTtSectionsPreview();
        document.getElementById('tt-grid-wrap').innerHTML = '';
        loadTimetableWeekView();
    });
    document.getElementById('tt-stream')?.addEventListener('change', () => {
        renderTtSectionsPreview();
        document.getElementById('tt-grid-wrap').innerHTML = '';
        loadTimetableWeekView();
    });
    document.getElementById('tt-period-count')?.addEventListener('input', () => {
        renderTtBreakAfterOptions();
        renderTtPeriodPreview();
    });
    document.getElementById('tt-period-minutes')?.addEventListener('input', renderTtPeriodPreview);
    document.getElementById('tt-break-after')?.addEventListener('change', renderTtPeriodPreview);
    document.getElementById('tt-break-minutes')?.addEventListener('input', renderTtPeriodPreview);
    document.getElementById('tt-start-time')?.addEventListener('input', (e) => {
        showStandardTimeHint('tt-start-time-eth', e.target.value);
        renderTtPeriodPreview();
    });
    document.getElementById('tt-generate-grid-btn')?.addEventListener('click', generateTtGrid);
    document.getElementById('ta-class-level')?.addEventListener('change', (e) => {
        updateStreamOptionsForLevel(document.getElementById('ta-stream'), e.target.value);
        renderTaSectionCheckboxes();
        refreshAssignmentSubjectOptions();
    });
    document.getElementById('ta-stream')?.addEventListener('change', () => {
        renderTaSectionCheckboxes();
        refreshAssignmentSubjectOptions();
    });
    document.getElementById('hr-class-level')?.addEventListener('change', (e) => {
        updateStreamOptionsForLevel(document.getElementById('hr-stream'), e.target.value);
        renderHrSectionOptions();
    });
    document.getElementById('hr-stream')?.addEventListener('change', renderHrSectionOptions);
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
    document.getElementById('students-class-filter')?.addEventListener('change', () => { refreshStudentSectionStreamFilters(); filterStudentsTable(); });
    document.getElementById('students-section-filter')?.addEventListener('change', filterStudentsTable);
    document.getElementById('students-stream-filter')?.addEventListener('change', () => { refreshStudentSectionStreamFilters(); filterStudentsTable(); });
    document.getElementById('students-status-filter')?.addEventListener('change', filterStudentsTable);
    document.getElementById('students-year-filter')?.addEventListener('change', () => loadStudents());
    document.getElementById('transferred-year-filter')?.addEventListener('change', filterTransferredByYear);
    document.getElementById('batches-year-filter')?.addEventListener('change', filterGraduationByYear);
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
    document.getElementById('ar-year-select')?.addEventListener('change', onAnalysisReportYearChange);
    document.getElementById('ar-print-btn')?.addEventListener('click', printAnalysisReport);

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
            document.getElementById(`tab-${btn.dataset.tab}`).style.display = 'block';
            // Switching tabs can swap in a different (or absent)
            // .sticky-filter-bar — re-measure, same reasoning as the
            // page-switch handler above.
            updateStickyOffsets();
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
            teachers: () => { loadTeacherLeaderboard(); loadTeacherAttendanceToday(); },
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
            stats.push(statCard(lucideIcon('plane-takeoff'), t('sa_stat_students_on_leave'), currentlyOnLeave, '', 'openStudentsOnLeaveModal'));

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
                        <div class="last-semester-grid">
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
                                <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 4px; border-bottom:1px solid var(--border); cursor:pointer;" ${actionAttrs('openTeacherAuditModal', [f.teacher_id])}>
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
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
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

function statCard(icon, label, value, tone, action, sub) {
    return `<div class="stat-card ${tone ? 'stat-' + tone : ''}" ${action ? `style="cursor:pointer" ${actionAttrs(action)}` : ''}>
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
        <div class="form-actions"><button class="btn btn-ghost" ${actionAttrs('closeModal', [])}>${t('sa_close')}</button></div>
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
    const data = await handleJsonResponse(res, t('sa_attendance_recorded'));
    if (data) loadTeacherAttendanceToday();
}

// ---------- QR scan check-in ----------
// A single Html5Qrcode instance, started/stopped as the Admin VP
// enters/leaves the Teachers & Attendance page (or hits Start/Stop),
// same pattern as any camera-based scanner: only one can own the
// device at a time, and it MUST be explicitly stopped or the browser
// keeps the camera light on after the admin navigates away.
let teacherQrScanner = null;
let teacherQrScanning = false;

function initTeacherQrScanner() {
    document.getElementById('teacher-qr-start-btn')?.addEventListener('click', startTeacherQrScanner);
    document.getElementById('teacher-qr-stop-btn')?.addEventListener('click', stopTeacherQrScanner);
    document.getElementById('teacher-attendance-refresh-btn')?.addEventListener('click', loadTeacherAttendanceToday);
}

async function startTeacherQrScanner() {
    if (teacherQrScanning) return;
    if (typeof Html5Qrcode !== 'function') {
        showToast(t('sa_qr_lib_unavailable'), 'error');
        return;
    }
    document.getElementById('teacher-qr-start-btn').style.display = 'none';
    document.getElementById('teacher-qr-stop-btn').style.display = '';
    teacherQrScanner = new Html5Qrcode('teacher-qr-reader');
    try {
        await teacherQrScanner.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: 220 },
            onTeacherQrDecoded,
            () => {} // per-frame "no QR found yet" — expected on almost every frame, not an error
        );
        teacherQrScanning = true;
    } catch (err) {
        console.error('startTeacherQrScanner error:', err);
        showToast(t('sa_qr_camera_error'), 'error');
        document.getElementById('teacher-qr-start-btn').style.display = '';
        document.getElementById('teacher-qr-stop-btn').style.display = 'none';
    }
}

async function stopTeacherQrScanner() {
    if (teacherQrScanner && teacherQrScanning) {
        try { await teacherQrScanner.stop(); } catch (err) { console.error('stopTeacherQrScanner error:', err); }
        try { teacherQrScanner.clear(); } catch {}
    }
    teacherQrScanning = false;
    document.getElementById('teacher-qr-start-btn').style.display = '';
    document.getElementById('teacher-qr-stop-btn').style.display = 'none';
}

// Debounce so the same badge held in front of the camera for a couple
// of seconds doesn't fire a dozen duplicate scans while the video
// keeps decoding the same frame content.
let lastTeacherQrScan = { text: null, at: 0 };
async function onTeacherQrDecoded(decodedText) {
    const now = Date.now();
    if (decodedText === lastTeacherQrScan.text && now - lastTeacherQrScan.at < 4000) return;
    lastTeacherQrScan = { text: decodedText, at: now };

    const resultEl = document.getElementById('teacher-qr-scan-result');
    const res = await apiFetch(`${API_BASE}/api/admin/teacher-attendance/scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qr_data: decodedText })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        resultEl.innerHTML = `<div class="qr-scan-feedback error">${lucideIcon('circle-x', 16)} ${escapeHtml(data.error || t('sa_load_error'))}</div>`;
        return;
    }
    resultEl.innerHTML = `<div class="qr-scan-feedback ${data.already_checked_in ? 'info' : 'success'}">${lucideIcon('circle-check', 16)} ${escapeHtml(data.message)}</div>`;
    loadTeacherAttendanceToday();
}

// "Who's here / who isn't yet" — the list an Admin VP checks after a
// scanning session. not_marked stays populated right up until the
// 11:00 Ethiopian-time (17:00 EAT) auto-absent sweep runs server-side,
// at which point those teachers move into the absent group on the
// next refresh.
async function loadTeacherAttendanceToday() {
    const body = document.getElementById('teacher-attendance-today-body');
    if (!body) return;
    const res = await apiFetch(`${API_BASE}/api/admin/teacher-attendance/today`);
    if (!res.ok) { body.innerHTML = `<div class="widget-empty">${t('sa_load_error')}</div>`; return; }
    const data = await res.json();

    const group = (list, statusClass, labelKey, icon) => `
        <div>
            <div class="teacher-attendance-group-heading">${lucideIcon(icon, 14)} ${t(labelKey)} (${list.length})</div>
            ${list.length === 0
                ? `<div class="widget-empty">${t('sa_no_data')}</div>`
                : `<div class="teacher-attendance-chip-list">${list.map(tch => `
                    <span class="teacher-attendance-chip status-${statusClass}">${escapeHtml(tch.full_name)}</span>`).join('')}</div>`}
        </div>`;

    body.innerHTML = `
        <div class="teacher-attendance-groups">
            ${group(data.not_marked, 'not_marked', 'sa_status_not_marked', 'clock')}
            ${group(data.present, 'present', 'sa_present', 'circle-check')}
            ${group(data.absent, 'absent', 'sa_absent', 'circle-x')}
        </div>`;
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
    if (!(await verifyAdminPassword())) return;
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
                ? `<button class="btn btn-sm btn-accent" ${actionAttrs('decidePenalty', [r.student_id, r.subject_id])}>${t('sa_decide')}</button>`
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
    if (!(await verifyAdminPassword())) return;
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
                <button class="btn btn-sm btn-success" ${actionAttrs('decideTeacherAbsence', [r.request_id, 'approve', 'admin'])}>${t('sa_approve')}</button>
                <button class="btn btn-sm btn-danger" ${actionAttrs('decideTeacherAbsence', [r.request_id, 'reject', 'admin'])}>${t('sa_reject')}</button>
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
                <button class="btn btn-sm btn-success" ${actionAttrs('decideStudentAbsence', [r.request_id, 'approve'])}>${t('sa_approve')}</button>
                <button class="btn btn-sm btn-danger" ${actionAttrs('decideStudentAbsence', [r.request_id, 'reject'])}>${t('sa_reject')}</button>
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
    if (!(await verifyAdminPassword())) return;
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
    if (!(await verifyAdminPassword())) return;
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
// page uses) — so Class Level/Stream here can only ever surface a
// section the Registrar actually configured; nothing is ever typed in.
// Subjects come from this school's own Subject Configuration grid
// (ticked from the zone/TDC subject dictionary), filtered to the
// selected stream, and are picked per grid cell rather than once for
// the whole form — a Grade 11 Natural Science slot can only ever be
// filled with a Natural Science (or All-Streams) subject.
let TT_CLASS_SECTIONS_CACHE = [];
let TT_SUBJECTS_CACHE = [];
let TT_ASSIGNMENTS_CACHE = [];

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
    updateStreamOptionsForLevel(document.getElementById('tt-stream'), levelSelect?.value || '');
    renderTtBreakAfterOptions();
    renderTtSectionsPreview();
    document.getElementById('tt-grid-wrap').innerHTML = '';
    loadTimetableWeekView();
}

// Sections the Registrar actually set up for the currently-picked Class
// Level + Stream — these become the grid's columns. Same
// normalizeStreamCode() bridge the Teaching Assignment page uses, since
// the Registrar's own stream field is free text.
function getTtSections() {
    const level = document.getElementById('tt-class-level')?.value || '';
    const stream = document.getElementById('tt-stream')?.value || '';
    if (!level || !stream) return [];
    let sections = TT_CLASS_SECTIONS_CACHE.filter(s => String(s.class_level) === String(level));
    sections = sections.filter(s => !s.stream || normalizeStreamCode(s.stream) === normalizeStreamCode(stream));
    return [...new Set(sections.map(s => s.section_name))].sort();
}

// Small read-only line so the Academic VP can see which sections will
// become grid columns before generating anything.
function renderTtSectionsPreview() {
    const el = document.getElementById('tt-sections-preview');
    if (!el) return;
    const sections = getTtSections();
    el.textContent = sections.length ? sections.join(', ') : t('sa_tt_no_sections');
}

// "Break after period N" needs its N options to track whatever period
// count is currently typed in.
function renderTtBreakAfterOptions() {
    const sel = document.getElementById('tt-break-after');
    if (!sel) return;
    const count = Number(document.getElementById('tt-period-count')?.value || 0);
    const current = sel.value;
    let html = `<option value="0">${t('sa_tt_no_break')}</option>`;
    for (let i = 1; i < count; i++) {
        html += `<option value="${i}">${t('sa_tt_after_period', { n: i })}</option>`;
    }
    sel.innerHTML = html;
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
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

// The Start Time field (and everything chained from it) is filled in as
// ETHIOPIAN time, not standard/GC time — an Academic VP typing "2:00"
// here means Ethiopian 2:00 (which is 08:00 standard), not literal
// standard 2:00 AM. Converting is a flat +6 hours (the same fixed
// offset toEthiopianTimeLabel subtracts to go the other way), wrapping
// past midnight if needed.
function ethiopianInputToStandard(hhmm) {
    if (!hhmm) return '';
    const mins = (hhmmToMinutes(hhmm) + 360) % 1440;
    return minutesToHhmm(mins);
}

function showStandardTimeHint(hintElId, hhmm) {
    const el = document.getElementById(hintElId);
    if (!el) return;
    if (!hhmm) { el.textContent = ''; return; }
    el.textContent = `${t('sa_standard_time_label')}: ${ethiopianInputToStandard(hhmm)}`;
}

// ---------- Period time math ----------
// Periods chain back-to-back from the start time using whatever period
// length is set (not fixed — 30, 40, 45 minutes, whatever the school
// actually runs). A break — a fixed extra gap after one specific period
// — just shifts every period after it forward by the break's own
// length; periods stay the same length on both sides of it.
const TT_PERIOD_MINUTES_DEFAULT = 40;

function hhmmToMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
}
function minutesToHhmm(mins) {
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Chaining happens on the raw Ethiopian-labeled clock the admin typed
// (it's just linear addition, so the fixed +6h offset to real/standard
// time can be applied once per boundary rather than changing how the
// chaining itself works). Every item's start_time/end_time below is the
// STANDARD equivalent — that's what's actually stored and compared
// against the database — with the Ethiopian value only computed at
// display time via toEthiopianTimeLabel(start_time).
function computeTtPeriods() {
    const startVal = document.getElementById('tt-start-time')?.value;
    const periodCount = Number(document.getElementById('tt-period-count')?.value || 0);
    const periodMinutes = Number(document.getElementById('tt-period-minutes')?.value || TT_PERIOD_MINUTES_DEFAULT);
    const breakAfter = Number(document.getElementById('tt-break-after')?.value || 0);
    const breakMinutes = Number(document.getElementById('tt-break-minutes')?.value || 0);
    if (!startVal || !periodCount || periodCount < 1 || !periodMinutes || periodMinutes < 1) return [];

    const items = [];
    let cursor = hhmmToMinutes(startVal); // Ethiopian-labeled minutes-of-day
    const toStandard = (ethMins) => minutesToHhmm((ethMins + 360) % 1440);
    for (let i = 1; i <= periodCount; i++) {
        const start = cursor;
        const end = start + periodMinutes;
        items.push({ type: 'period', index: i, start_time: toStandard(start), end_time: toStandard(end) });
        cursor = end;
        if (breakAfter && i === breakAfter && breakMinutes > 0) {
            const breakStart = cursor;
            const breakEnd = cursor + breakMinutes;
            items.push({ type: 'break', start_time: toStandard(breakStart), end_time: toStandard(breakEnd) });
            cursor = breakEnd;
        }
    }
    return items;
}

// Live preview of the computed period times as the Academic VP tweaks
// start time / period count / period length / break settings, before
// they've even generated the subject grid. Ethiopian time (what was
// actually typed in, chained forward) leads; standard time is the
// secondary reference next to it.
function renderTtPeriodPreview() {
    const el = document.getElementById('tt-period-preview');
    if (!el) return;
    const items = computeTtPeriods();
    if (items.length === 0) { el.textContent = ''; return; }
    el.innerHTML = items.map(p => p.type === 'break'
        ? `<span class="tt-period-chip tt-period-chip-break">${t('sa_tt_break_label')} ${toEthiopianTimeLabel(p.start_time)}\u2013${toEthiopianTimeLabel(p.end_time)} <span class="tt-period-chip-eth">(${p.start_time}\u2013${p.end_time})</span></span>`
        : `<span class="tt-period-chip">${p.index}. ${toEthiopianTimeLabel(p.start_time)}\u2013${toEthiopianTimeLabel(p.end_time)} <span class="tt-period-chip-eth">(${p.start_time}\u2013${p.end_time})</span></span>`
    ).join(' ');
}

// Builds the periods x sections grid — one subject dropdown per cell,
// scoped to subjects configured for the selected stream (plus any
// "All Streams" subject), pre-filled from whatever's already saved for
// this exact class level/stream/day.
async function generateTtGrid() {
    const level = document.getElementById('tt-class-level')?.value || '';
    const stream = document.getElementById('tt-stream')?.value || '';
    const day = document.getElementById('tt-day')?.value || '';
    const sections = getTtSections();
    const periods = computeTtPeriods();
    const wrap = document.getElementById('tt-grid-wrap');

    if (!level || !stream) return showToast(t('sa_err_class_fields_required'), 'error');
    if (sections.length === 0) return showToast(t('sa_tt_no_sections'), 'error');
    if (periods.filter(p => p.type === 'period').length === 0) return showToast(t('sa_tt_no_periods'), 'error');

    wrap.innerHTML = `<p class="page-subtitle">${t('sa_loading')}</p>`;

    const [existingRes, assignRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/admin/timetable?class_level=${encodeURIComponent(level)}&stream=${encodeURIComponent(stream)}`),
        apiFetch(`${API_BASE}/api/academic-vp/teacher-assignments`)
    ]);
    const existingRows = existingRes.ok ? await existingRes.json() : [];
    TT_ASSIGNMENTS_CACHE = assignRes.ok ? await assignRes.json() : [];

    const existingByKey = {};
    existingRows.filter(r => String(r.day_of_week) === String(day)).forEach(r => {
        existingByKey[`${r.section}|${r.start_time}`] = r.subject_id;
    });

    // Same stream rule as everywhere else in this page: a subject
    // configured for "All Streams" (stream = null) is always offered,
    // on top of whichever specific stream is selected.
    const subjectOptions = TT_SUBJECTS_CACHE.filter(s => !s.stream || s.stream === stream);

    let html = `<table class="data-table tt-grid-table"><thead><tr><th>${t('sa_tt_col_period')}</th>`
        + sections.map(sec => `<th>${escapeHtml(sec)}</th>`).join('') + `</tr></thead><tbody>`;

    periods.forEach(p => {
        if (p.type === 'break') {
            html += `<tr class="tt-grid-break-row"><td colspan="${sections.length + 1}">${t('sa_tt_break_label')} (${p.start_time}\u2013${p.end_time})</td></tr>`;
            return;
        }
        html += `<tr><td class="tt-grid-period-cell">${p.index}<br><span class="form-hint">${toEthiopianTimeLabel(p.start_time)}\u2013${toEthiopianTimeLabel(p.end_time)}<br>${p.start_time}\u2013${p.end_time}</span></td>`;
        sections.forEach(sec => {
            const key = `${sec}|${p.start_time}`;
            const selected = existingByKey[key] || '';
            const cellId = `tt-cell-${sec}-${p.index}`;
            html += `<td>
                <select class="tt-grid-cell form-control" id="${cellId}" data-section="${escapeHtml(sec)}" data-period="${p.index}" data-start="${p.start_time}" data-end="${p.end_time}">
                    <option value="">${t('sa_tt_blank_cell')}</option>
                    ${subjectOptions.map(s => `<option value="${s.subject_id}" ${String(s.subject_id) === String(selected) ? 'selected' : ''}>${escapeHtml(s.subject_name)}</option>`).join('')}
                </select>
                <div class="form-hint tt-grid-teacher-hint" id="${cellId}-hint"></div>
            </td>`;
        });
        html += `</tr>`;
    });
    html += `</tbody></table>
        <div class="form-actions">
            <button class="btn btn-accent" ${actionAttrs('saveTtGrid', [])}>${t('sa_tt_save_day_btn')}</button>
        </div>`;
    wrap.innerHTML = html;

    sections.forEach(sec => {
        periods.filter(p => p.type === 'period').forEach(p => {
            const cellId = `tt-cell-${sec}-${p.index}`;
            if (document.getElementById(cellId)?.value) updateTtCellTeacherHint(cellId);
        });
    });
    // Prefilled cells (from a previous save) should already be
    // conflict-free, but run the same check on load too so a stale
    // save from before these rules existed doesn't silently stay
    // broken.
    applyTtConflicts();
}

function onTtCellChange(cellId) {
    updateTtCellTeacherHint(cellId);
    applyTtConflicts();
}

// Two rules govern which subjects are pickable in any given cell, and
// both are checked together in one pass over the whole grid (rather
// than as two separate functions each resetting disabled/label state)
// so neither rule can stomp on the other's result for the same
// <option> — e.g. an option that's disabled for the Section Conflict
// reason shouldn't get silently re-enabled by a Period Conflict pass
// that only knows about its own rule.
//   - Section Conflict: a subject already picked for one section in a
//     given period can't be picked for any OTHER section in that same
//     period — its teacher is already booked at that time.
//   - Period Conflict: a subject already picked for one period in a
//     given section can't be picked again for any OTHER period in
//     that same section on this same day — a section only gets a
//     subject once per day.
function applyTtConflicts() {
    const cells = [...document.querySelectorAll('.tt-grid-cell')];
    const usedByPeriod = {};   // period -> { subject_id: section }
    const usedBySection = {};  // section -> { subject_id: period }
    cells.forEach(sel => {
        if (!sel.value) return;
        const { period, section } = sel.dataset;
        (usedByPeriod[period] ||= {})[sel.value] = section;
        (usedBySection[section] ||= {})[sel.value] = period;
    });
    cells.forEach(sel => {
        const mySection = sel.dataset.section;
        const myPeriod = sel.dataset.period;
        [...sel.options].forEach(opt => {
            if (!opt.value) return;
            const subject = TT_SUBJECTS_CACHE.find(s => String(s.subject_id) === opt.value);
            const baseLabel = subject ? subject.subject_name : opt.textContent.split(' \u2014 ')[0];
            const sectionUsingThisPeriod = usedByPeriod[myPeriod]?.[opt.value];
            const periodUsingThisSection = usedBySection[mySection]?.[opt.value];
            if (sectionUsingThisPeriod && sectionUsingThisPeriod !== mySection) {
                opt.disabled = true;
                opt.textContent = `${baseLabel} \u2014 ${t('sa_tt_taken_by_section', { section: sectionUsingThisPeriod })}`;
            } else if (periodUsingThisSection && periodUsingThisSection !== myPeriod) {
                opt.disabled = true;
                opt.textContent = `${baseLabel} \u2014 ${t('sa_tt_already_period', { period: periodUsingThisSection })}`;
            } else {
                opt.disabled = false;
                opt.textContent = baseLabel;
            }
        });
    });
}

// Purely informational — shows who's actually assigned to teach the
// picked subject in that section, right under the dropdown, the same
// way the old single-slot form used to show it above the Add button.
function updateTtCellTeacherHint(cellId) {
    const select = document.getElementById(cellId);
    const hint = document.getElementById(`${cellId}-hint`);
    if (!select || !hint) return;
    const subject_id = select.value;
    const section = select.dataset.section;
    const level = document.getElementById('tt-class-level')?.value || '';
    if (!subject_id) { hint.textContent = ''; return; }
    const match = TT_ASSIGNMENTS_CACHE.find(a =>
        String(a.subject_id) === String(subject_id) && a.section === section && String(a.class_level) === String(level));
    hint.textContent = match ? `${t('sa_teacher_auto_label')}: ${match.teacher_name}` : t('sa_tt_teacher_none');
}

// One password prompt for the whole day's grid (not one per cell) —
// sends every cell at once, blank ones included, so the server can do a
// clean full replace for this class_level/stream/day (see the bulk
// endpoint's own comment for why).
async function saveTtGrid() {
    const level = document.getElementById('tt-class-level')?.value || '';
    const stream = document.getElementById('tt-stream')?.value || '';
    const day = document.getElementById('tt-day')?.value || '';
    const cells = [...document.querySelectorAll('.tt-grid-cell')];
    if (cells.length === 0) return;
    const slots = cells.map(sel => ({
        section: sel.dataset.section,
        period: sel.dataset.period,
        subject_id: sel.value || null,
        start_time: sel.dataset.start,
        end_time: sel.dataset.end
    }));

    // Belt-and-braces: the dropdowns already stop a NEW conflicting pick
    // from being made, but a conflict saved before these rules existed
    // could still be sitting in a prefilled cell untouched. Catch both
    // here rather than letting a real double-booking or same-day repeat
    // slip through save.
    //   1) Section Conflict — same subject picked for the same period
    //      in more than one section (one teacher, two sections at once).
    const byPeriodSubject = {};
    for (const s of slots) {
        if (!s.subject_id) continue;
        const key = `${s.period}|${s.subject_id}`;
        (byPeriodSubject[key] ||= []).push(s.section);
    }
    const conflict = Object.entries(byPeriodSubject).find(([, secs]) => secs.length > 1);
    if (conflict) {
        const [key, secs] = conflict;
        const [period] = key.split('|');
        return showToast(t('sa_tt_conflict_error', { period, sections: secs.join(', ') }), 'error');
    }

    //   2) Period Conflict — same subject picked more than once for the
    //      same section across different periods (a section only gets
    //      a subject once per day).
    const bySectionSubject = {};
    for (const s of slots) {
        if (!s.subject_id) continue;
        const key = `${s.section}|${s.subject_id}`;
        (bySectionSubject[key] ||= []).push(s.period);
    }
    const dupConflict = Object.entries(bySectionSubject).find(([, periods]) => periods.length > 1);
    if (dupConflict) {
        const [key, periods] = dupConflict;
        const [section, subjectId] = key.split('|');
        const subject = TT_SUBJECTS_CACHE.find(sub => String(sub.subject_id) === subjectId);
        const subjectName = subject ? subject.subject_name : subjectId;
        return showToast(t('sa_tt_dup_subject_error', { subject: subjectName, section, periods: periods.join(', ') }), 'error');
    }

    if (!(await verifyAdminPassword())) return;
    const res = await apiFetch(`${API_BASE}/api/admin/timetable/bulk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ class_level: level, stream, day_of_week: Number(day), slots: slots.map(({ section, subject_id, start_time, end_time }) => ({ section, subject_id, start_time, end_time })) })
    });
    const data = await handleJsonResponse(res, t('sa_tt_grid_saved'));
    if (!data) return;
    loadTimetableWeekView();
}

// Read-only view of everything currently saved for the picked Class
// Level + Stream, across every section and every day — a quick way to
// see the whole week at a glance without regenerating the edit grid.
async function loadTimetableWeekView() {
    const level = document.getElementById('tt-class-level')?.value || '';
    const stream = document.getElementById('tt-stream')?.value || '';
    const tbody = document.getElementById('sa-timetable-tbody');
    if (!tbody) return;
    if (!level || !stream) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_tt_pick_class_stream_first')}</td></tr>`; return; }
    tbody.innerHTML = `<tr><td colspan="6">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/admin/timetable?class_level=${encodeURIComponent(level)}&stream=${encodeURIComponent(stream)}`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    const dayNames = ['', t('sa_monday'), t('sa_tuesday'), t('sa_wednesday'), t('sa_thursday'), t('sa_friday')];
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${dayNames[r.day_of_week] || r.day_of_week}</td>
            <td>${r.start_time} - ${r.end_time}</td>
            <td>${toEthiopianTimeLabel(r.start_time)} - ${toEthiopianTimeLabel(r.end_time)}</td>
            <td>${escapeHtml(r.section)}</td>
            <td>${escapeHtml(r.subject_name)}</td>
            <td>${r.teacher_name ? `${escapeHtml(r.teacher_name)} (${escapeHtml(r.teacher_id)})` : '—'}</td>
        </tr>`).join('');
}

// ==========================================================
// MARKS REVIEW (Academic VP)
// ==========================================================
async function loadMarksReview() {
    const tbody = document.getElementById('sa-marks-review-tbody');
    tbody.innerHTML = `<tr><td colspan="6">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/marks-review`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.full_name)} (${escapeHtml(r.teacher_id)})</td>
            <td>${r.class_level}-${r.section} (${escapeHtml(r.stream || '')})</td>
            <td><span class="badge badge-${r.pushed ? 'approved' : 'pending'}">${r.pushed ? t('sa_pushed') : t('sa_not_pushed')}</span></td>
            <td>${r.pushed_at ? formatEthDateTime(r.pushed_at) : '—'}</td>
            <td>${r.pushed
                ? (r.incomplete_count > 0
                    ? `<span class="badge badge-rejected">${r.incomplete_count} ${t('sa_incomplete')}</span>`
                    : '—')
                : '—'}</td>
            <td>${r.pushed && r.incomplete_count > 0
                ? `<button class="btn btn-sm btn-danger" ${actionAttrs('reopenMarksReport', [r.teacher_id, r.incomplete_count])}>${t('sa_send_reentry_approval')}</button>`
                : '—'}</td>
        </tr>`).join('');
}

// Academic VP sends a homeroom teacher's already-pushed report back for
// correction — only offered once that section is pushed AND has at
// least one Incomplete student (the button doesn't even render
// otherwise). Unlocks the homeroom teacher's editing on their end so
// they can fix those students and push again.
async function reopenMarksReport(teacher_id, incomplete_count) {
    if (!(await showConfirmModal(t('sa_confirm_reopen_marks', { count: incomplete_count }), { danger: true }))) return;
    const note = await showPromptModal(t('sa_prompt_reopen_note')) || '';
    if (!(await verifyAdminPassword())) return;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/marks-review/${teacher_id}/reopen`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note })
    });
    await handleJsonResponse(res, t('sa_reentry_approval_sent'));
    loadMarksReview();
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
// Generic re-authentication gate for ANY School Admin action — assigning,
// removing, approving, granting, or revoking anything requires the
// logged-in admin (Admin VP, Academic VP, or Principal) to re-enter their
// own login password immediately before the action goes through. Doesn't
// issue a new session, just confirms the password again against the same
// school_admins.security_password used at login.
async function verifyAdminPassword(promptMessage) {
    const password = await showPasswordPromptModal(promptMessage || t('sa_action_password_prompt'));
    if (!password) return false;
    const res = await apiFetch(`${API_BASE}/api/admin/verify-password`, {
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

// Kept as a thin alias — older call sites were written against this name
// specifically, and it's the same check either way.
async function verifyAcademicVpPassword(promptMessage) {
    return verifyAdminPassword(promptMessage);
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
                <button class="btn btn-sm btn-success" ${actionAttrs('decideTeacherAbsence', [r.request_id, 'approve', 'principal'])}>${t('sa_approve')}</button>
                <button class="btn btn-sm btn-danger" ${actionAttrs('decideTeacherAbsence', [r.request_id, 'reject', 'principal'])}>${t('sa_reject')}</button>
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
                <button class="btn btn-sm btn-ghost" ${actionAttrs('decideCase', [r.case_id, 'dismissed'])}>${t('sa_dismiss')}</button>
                <button class="btn btn-sm btn-danger" ${actionAttrs('decideCase', [r.case_id, 'terminated'])}>${t('sa_terminate')}</button>
            </td>
        </tr>`).join('');
}

async function decideCase(case_id, decision) {
    if (decision === 'terminated' && !(await showConfirmModal(t('sa_confirm_terminate'), { danger: true }))) return;
    const note = await showPromptModal(t('sa_prompt_decision_note')) || '';
    if (!(await verifyAdminPassword())) return;
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
                <button class="btn btn-sm btn-success" ${actionAttrs('decideDocumentRequest', [r.request_id, 'approve'])}>${t('sa_approve')}</button>
                <button class="btn btn-sm btn-danger" ${actionAttrs('decideDocumentRequest', [r.request_id, 'reject'])}>${t('sa_reject')}</button>
            </td>
        </tr>`).join('');
}

async function decideDocumentRequest(request_id, action) {
    let body = {};
    if (action === 'reject') body = { reason: await showPromptModal(t('sa_prompt_rejection_reason')) || '' };
    if (!(await verifyAdminPassword())) return;
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
                    : `<button class="btn btn-sm btn-accent" ${actionAttrs('issueAward', [r.student_id])}>${t('sa_award')}</button>`)
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
            <td><a href="#" ${actionAttrs('openTeacherAuditModal', [r.teacher_id])}>${escapeHtml([r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '))}</a></td>
            <td>${escapeHtml(r.subject_name)}</td>
            <td>${escapeHtml(r.class_level)}-${escapeHtml(r.section)}${r.stream ? ` (${escapeHtml(r.stream)})` : ''}</td>
            <td>${escapeHtml(r.reason || '—')}</td>
            <td>${formatEthDate(r.requested_at)}</td>
            <td>
                <button class="btn btn-sm btn-accent" ${actionAttrs('decideSubjectEntryRequest', [r.id, 'approve'])}>${t('sa_approve')}</button>
                <button class="btn btn-sm btn-ghost" ${actionAttrs('decideSubjectEntryRequest', [r.id, 'reject'])}>${t('sa_reject')}</button>
            </td>
        </tr>`).join('');
}

async function decideSubjectEntryRequest(id, action) {
    let body = {};
    if (action === 'reject') body = { reason: await showPromptModal(t('sa_prompt_rejection_reason')) || '' };
    if (!(await verifyAdminPassword())) return;
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
                <button class="btn btn-sm btn-accent" ${actionAttrs('decideDropoutRequest', [r.student_id, 'approve'])}>${t('sa_approve')}</button>
                <button class="btn btn-sm btn-ghost" ${actionAttrs('decideDropoutRequest', [r.student_id, 'reject'])}>${t('sa_reject')}</button>
            </td>
        </tr>`).join('');
}

async function decideDropoutRequest(student_id, action) {
    if (action === 'approve' && !(await showConfirmModal(t('sa_dropout_approve_confirm')))) return;
    if (!(await verifyAdminPassword())) return;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/dropout-requests/${student_id}/${action}`, { method: 'POST' });
    await handleJsonResponse(res, action === 'approve' ? t('sa_dropout_approved_msg') : t('sa_dropout_rejected_msg'));
    loadDropoutRequests();
}

// ==========================================================
// SEMESTER / YEARLY ANALYSIS REPORT (Principal / Academic VP / Admin VP)
// ==========================================================
const AR_CATS = ['total_student', 'drop_out', 'tested', 'incomplete', 'band_0_49', 'band_50_74', 'band_75_100'];
// Populated once from /api/academic-years, same source as the Students
// tab's year filter — {id, label, is_current} per past year.
let AR_ACADEMIC_YEARS_LOADED = false;

async function loadAnalysisReportYearOptions() {
    const sel = document.getElementById('ar-year-select');
    if (!sel || AR_ACADEMIC_YEARS_LOADED) return;
    const res = await apiFetch(`${API_BASE}/api/academic-years`);
    if (!res.ok) return;
    const years = await res.json();
    const pastYears = years.filter(y => !y.is_current);
    sel.innerHTML = `<option value="">${t('sa_current_year')}</option>` +
        pastYears.map(y => `<option value="${y.id}">${escapeHtml(y.label)}</option>`).join('');
    AR_ACADEMIC_YEARS_LOADED = true;
}

// A past year's snapshot has no Semester 1 / Semester 2 split (see
// getPastYearAnalysisReport on the server) — only one figure exists per
// year, taken at rollover. So the Term dropdown is meaningless once a
// past year is picked; disable it rather than let it imply a distinction
// that isn't there.
function onAnalysisReportYearChange() {
    const yearVal = document.getElementById('ar-year-select')?.value || '';
    const termSel = document.getElementById('ar-term-select');
    if (termSel) termSel.disabled = !!yearVal;
    loadAnalysisReport();
}

async function loadAnalysisReport() {
    const tbody = document.getElementById('sa-analysis-report-tbody');
    await loadAnalysisReportYearOptions();
    const term = document.getElementById('ar-term-select')?.value || 'Year';
    const yearId = document.getElementById('ar-year-select')?.value || '';

    // Only the Principal's account has a signature/seal on file to sign
    // the PDF with (see /api/principal/analysis-report/pdf on the
    // server) — Academic VP and Admin VP can view this same data above,
    // but the print button would just 403 for them, so hide it instead
    // of leaving a button that looks broken.
    const printBtn = document.getElementById('ar-print-btn');
    const printNote = document.getElementById('ar-print-note');
    const pastYearNote = document.getElementById('ar-past-year-note');
    const isPrincipal = CURRENT_TITLE === 'Principal';
    if (printBtn) printBtn.style.display = isPrincipal ? '' : 'none';
    if (printNote) printNote.style.display = isPrincipal ? 'none' : '';
    if (pastYearNote) pastYearNote.style.display = yearId ? '' : 'none';

    tbody.innerHTML = `<tr><td colspan="23">${t('sa_loading')}</td></tr>`;
    const url = yearId
        ? `${API_BASE}/api/principal/analysis-report?term=${encodeURIComponent(term)}&academic_year_id=${encodeURIComponent(yearId)}`
        : `${API_BASE}/api/principal/analysis-report?term=${encodeURIComponent(term)}`;
    const res = await apiFetch(url);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="23">${t('sa_load_error')}</td></tr>`; return; }
    const data = await res.json();
    // Past-year rows leave several fields as null (nothing left to show —
    // see getPastYearAnalysisReport) — render those as "N/A" rather than
    // the literal string "null" a template literal would otherwise produce.
    const cell = (v) => (v === null || v === undefined) ? t('sa_not_applicable') : v;
    const rowHtml = (r, isTotal) => `
        <tr ${isTotal ? 'style="font-weight:bold;background:var(--bg-subtle,#f7f7f7);"' : ''}>
            <td>${escapeHtml(String(r.class_level))}</td>
            ${AR_CATS.map(k => `<td>${cell(r[k].male)}</td><td>${cell(r[k].female)}</td><td>${cell(r[k].total)}</td>`).join('')}
            <td>${cell(r.highest_rank_male)}</td>
            <td>${cell(r.highest_rank_female)}</td>
        </tr>`;
    if (!data.rows || data.rows.length === 0) { tbody.innerHTML = `<tr><td colspan="23">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = data.rows.map(r => rowHtml(r, false)).join('') + rowHtml(data.totals, true);
}

function printAnalysisReport() {
    const term = document.getElementById('ar-term-select')?.value || 'Year';
    const yearId = document.getElementById('ar-year-select')?.value || '';
    const url = yearId
        ? `${API_BASE}/api/principal/analysis-report/pdf?term=${encodeURIComponent(term)}&academic_year_id=${encodeURIComponent(yearId)}`
        : `${API_BASE}/api/principal/analysis-report/pdf?term=${encodeURIComponent(term)}`;
    window.open(url, '_blank');
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
// Infinite-scroll state for the (potentially large) student roster: the
// table only ever renders STUDENTS_RENDER_LIMIT rows at a time out of
// the full filtered set, growing by STUDENTS_PAGE_SIZE as the user
// scrolls near the bottom (see maybeLoadMoreStudentRows below) rather
// than rendering hundreds of rows up front.
const STUDENTS_PAGE_SIZE = 20;
let STUDENTS_RENDER_LIMIT = STUDENTS_PAGE_SIZE;
let STUDENTS_FILTERED_LIST = [];
let SCHOOL_LEADERBOARD_DATA = null;
// Hidden from the roster by default (no Status filter picked) — Graduated
// and Transferred already have their own tabs, and Unregistered means a
// returning student hasn't had this year's promote/retain decision
// recorded yet (see rolloverAcademicYear), so the default view is "who's
// actually registered/promoted this year". Picking a specific status in
// the Status filter overrides this and shows exactly that status instead.
const STUDENT_HIDDEN_BY_DEFAULT = s => s.status === 'Graduated' || String(s.status || '').startsWith('Transferred') || s.status === 'Unregistered';
// The Status filter still defaults to "" (All Statuses) as far as its own
// meaning goes, but the page itself should land on Active students, not
// everyone "All Statuses" would otherwise include (Inactive, Pending
// Promotion, Dropped, and any stray legacy status values that don't match
// the app's known list at all). So the very first time the filter options
// are populated for this page load, the selection is forced to 'Active'
// instead of whatever it defaults to; after that, the person's own choice
// (including switching back to "All Statuses") is respected as normal.
let STUDENTS_STATUS_FILTER_DEFAULTED = false;
let ALL_ACADEMIC_YEARS = [];

// The five statuses students.status ever actually holds in this app —
// same ones the Registrar's Student Status & Academic Year Management
// screens work with (see the "'Pending Promotion' — one of the four
// Student Status..." comment in server.js; 'Transferred - Completed'
// is the one literal Transferred value ever written, shown here under
// the shorter label an admin actually thinks in). Used for the Status
// filter instead of deriving options from whichever statuses happen to
// appear in currently-loaded students, so e.g. "Pending Promotion" is
// always selectable even on a day nobody happens to be in that state.
const STUDENT_STATUS_OPTIONS = [
    { value: 'Active', labelKey: 'sa_status_active' },
    { value: 'Inactive', labelKey: 'sa_status_inactive' },
    { value: 'Unregistered', labelKey: 'sa_status_unregistered' },
    { value: 'Pending Promotion', labelKey: 'sa_status_pending_promotion' },
    { value: 'Transferred - Completed', labelKey: 'sa_status_transferred' },
    { value: 'Graduated', labelKey: 'sa_status_graduated' }
];

// Registrar-configured classes/sections/streams (class_sections table,
// via /api/class-sections) — cached for the life of the page load since
// Section Setup changes are rare enough that a refresh is an acceptable
// way to pick up edits made mid-session.
let ALL_CLASS_SECTIONS = [];
async function loadClassSectionsConfig() {
    if (ALL_CLASS_SECTIONS.length > 0) return;
    const res = await apiFetch(`${API_BASE}/api/class-sections`);
    if (res.ok) ALL_CLASS_SECTIONS = await res.json();
}

// Section options only ever list what the Registrar has configured for
// the currently-selected class level (+ stream, once narrowed) under
// Section Setup — not whatever section names happen to appear on
// currently-loaded students. Stream options auto-narrow off the class
// level the same way the Timetable/Assignment forms already do via
// updateStreamOptionsForLevel(): Grade 9 & 10 only ever run "General"
// (no science split yet), Grade 11 & 12 split into Natural or Social
// Science.
function refreshStudentSectionStreamFilters() {
    const classSel = document.getElementById('students-class-filter');
    const sectionSel = document.getElementById('students-section-filter');
    const streamSel = document.getElementById('students-stream-filter');
    if (!classSel || !sectionSel || !streamSel) return;

    const level = classSel.value;
    const prevStream = streamSel.value;

    if (level === '9' || level === '10') {
        // Only one stream is possible at this level, so offering "All
        // Streams" next to "General" is a redundant, confusing choice —
        // same convention as updateStreamOptionsForLevel() elsewhere:
        // just lock the field to the one real value.
        streamSel.innerHTML = `<option value="General">${t('sa_stream_general')}</option>`;
        streamSel.value = 'General';
        streamSel.disabled = true;
    } else if (level === '11' || level === '12') {
        // Long-form values ('Natural Science'/'Social Science') to match
        // students.stream/class_sections.stream directly — same
        // convention updateStreamOptionsForLevel() now uses everywhere
        // else a stream gets picked.
        streamSel.disabled = false;
        streamSel.innerHTML = `
            <option value="">${t('sa_all_streams')}</option>
            <option value="Natural Science">${t('sa_stream_natural')}</option>
            <option value="Social Science">${t('sa_stream_social')}</option>`;
        if ([...streamSel.options].some(o => o.value === prevStream)) streamSel.value = prevStream;
    } else {
        // No class picked yet — offer every stream this school actually
        // has configured, rather than guessing. class_sections.stream is
        // already stored in the long form ('Natural Science'), so this
        // maps that directly to its translated label.
        streamSel.disabled = false;
        const streamLabel = { General: t('sa_stream_general'), 'Natural Science': t('sa_stream_natural'), 'Social Science': t('sa_stream_social') };
        const streams = [...new Set(ALL_CLASS_SECTIONS.map(cs => cs.stream).filter(Boolean))];
        streamSel.innerHTML = `<option value="">${t('sa_all_streams')}</option>` +
            streams.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(streamLabel[s] || s)}</option>`).join('');
        if ([...streamSel.options].some(o => o.value === prevStream)) streamSel.value = prevStream;
    }

    const streamVal = streamSel.value;
    const prevSection = sectionSel.value;
    const matches = ALL_CLASS_SECTIONS.filter(cs =>
        (!level || String(cs.class_level) === String(level)) &&
        (!streamVal || cs.stream === streamVal)
    );
    const sectionNames = [...new Set(matches.map(cs => cs.section_name))].sort((a, b) => a.localeCompare(b));
    sectionSel.innerHTML = `<option value="">${t('sa_all_sections')}</option>` +
        sectionNames.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (sectionNames.includes(prevSection)) sectionSel.value = prevSection;
}

async function loadStudents() {
    const tbody = document.getElementById('sa-students-tbody');
    tbody.innerHTML = `<tr><td colspan="7">${t('sa_loading')}</td></tr>`;
    if (ALL_ACADEMIC_YEARS.length === 0) await loadStudentYearFilterOptions();
    await loadClassSectionsConfig();
    const yearId = document.getElementById('students-year-filter')?.value || '';
    const url = yearId ? `${API_BASE}/api/students?academic_year_id=${encodeURIComponent(yearId)}` : `${API_BASE}/api/students`;
    const res = await apiFetch(url);
    if (res.ok) {
        ALL_STUDENTS = await res.json();
        populateStudentFilterOptions();
        filterStudentsTable();
    } else {
        tbody.innerHTML = `<tr><td colspan="7">${t('sa_load_error')}</td></tr>`;
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

// Populates the Academic Year filter — "Current Year" plus every past
// year a Semester-2 closure has rolled over into (most recent first).
// Only (re)fetched once per page load; switching years just re-triggers
// loadStudents() with the picked id, it doesn't need the list refetched.
async function loadStudentYearFilterOptions() {
    const sel = document.getElementById('students-year-filter');
    if (!sel) return;
    const res = await apiFetch(`${API_BASE}/api/academic-years`);
    if (!res.ok) return;
    ALL_ACADEMIC_YEARS = await res.json();
    const current = sel.value;
    const pastYears = ALL_ACADEMIC_YEARS.filter(y => !y.is_current);
    sel.innerHTML = `<option value="">${t('sa_current_year')}</option>` +
        pastYears.map(y => `<option value="${y.id}">${escapeHtml(y.label)}</option>`).join('');
    sel.value = current;
}

function populateStudentFilterOptions() {
    const classSel = document.getElementById('students-class-filter');
    const statusSel = document.getElementById('students-status-filter');
    if (!classSel) return;
    const uniq = key => [...new Set(ALL_STUDENTS.map(s => s[key]).filter(Boolean))]
        .sort((a, b) => (isNaN(a) || isNaN(b)) ? String(a).localeCompare(String(b)) : a - b);
    const buildOptions = (sel, values, allLabelKey) => {
        const current = sel.value;
        sel.innerHTML = `<option value="">${t(allLabelKey)}</option>` + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
        sel.value = current;
    };
    buildOptions(classSel, uniq('class_level'), 'sa_all_classes');
    // Section/Stream now come from the Registrar's Section Setup config
    // (see refreshStudentSectionStreamFilters), not from whichever values
    // happen to appear on currently-loaded students.
    refreshStudentSectionStreamFilters();
    if (statusSel) {
        const current = STUDENTS_STATUS_FILTER_DEFAULTED ? statusSel.value : 'Active';
        STUDENTS_STATUS_FILTER_DEFAULTED = true;
        statusSel.innerHTML = `<option value="">${t('sa_all_statuses')}</option>` +
            STUDENT_STATUS_OPTIONS.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(t(o.labelKey))}</option>`).join('');
        statusSel.value = current;
    }
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
    if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="7">${t('sa_no_data')}</td></tr>`; return; }
    // Only the rows within the current infinite-scroll window are
    // actually rendered — the stat cards above still reflect every
    // matching student, not just the ones currently on screen.
    const visible = list.slice(0, STUDENTS_RENDER_LIMIT);
    tbody.innerHTML = visible.map(s => `
        <tr>
            <td class="table-id-cell">${tableAvatarHtml([s.first_name, s.last_name].filter(Boolean).join(' '), s.id_photo_url, { previewable: true })}<span>${escapeHtml(s.student_id)}</span></td>
            <td>${escapeHtml([s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' '))}</td>
            <td>${escapeHtml(s.class_level ?? '—')}</td>
            <td>${escapeHtml(s.section ?? '—')}</td>
            <td>${escapeHtml(s.stream ?? '—')}</td>
            <td>${escapeHtml(s.fayda_number || '—')}</td>
            <td>${escapeHtml(s.status || '—')}</td>
        </tr>`).join('');
}

// ---------- Roster downloads (CSV / PDF) ----------
// Any field that could contain a comma, quote, or newline gets wrapped
// in quotes (with internal quotes doubled), per RFC 4180 — free-text
// fields like names/statuses can't skip this.
function csvField(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// Digit-only values (Fayda numbers, phone numbers) need MORE than the
// quoting above, or a spreadsheet app opening the CSV will still treat
// them as a literal number — which either drops a leading zero (phone
// numbers) or, once there are enough digits to lose precision, switches
// to lossy scientific notation (Fayda's 16-digit numbers rendering as
// "2.45749E+15", which is what prompted this fix). Wrapping the value
// as an Excel "text formula" (="...") forces it to display exactly as
// typed instead of being auto-converted.
function csvExcelSafeField(v) {
    const s = String(v ?? '');
    if (/^\d+$/.test(s)) return `="${s}"`;
    return csvField(s);
}
function downloadCsv(filename, headers, rows) {
    // Leading BOM so Excel (incl. on Windows) opens the file as UTF-8
    // instead of misreading non-ASCII names.
    const csv = '\uFEFF' + [headers.map(csvField).join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

// Both roster downloads support two output formats — CSV (for
// importing into Excel/Sheets or another system) and PDF (for
// printing/sharing as a document) — offered as a small choice instead
// of picking one on the admin's behalf. One lookup table covers every
// roster this modal is used for, rather than a growing if/else per kind.
const DOWNLOAD_FORMAT_HANDLERS = {
    student: ['downloadStudentRosterCsv', 'downloadStudentRosterPdf'],
    teacher: ['downloadTeacherRosterCsv', 'downloadTeacherRosterPdf'],
    transferred: ['downloadTransferredCsv', 'downloadTransferredPdf'],
    graduation: ['downloadGraduationCsv', 'downloadGraduationPdf']
};
function openDownloadFormatModal(kind) {
    const [csvFn, pdfFn] = DOWNLOAD_FORMAT_HANDLERS[kind] || [];
    if (!csvFn) return;
    openModal(`
        <h3>${t('sa_download_format_heading')}</h3>
        <div class="form-actions" style="margin-top: 14px;">
            <button class="btn btn-primary" ${actionAttrs(csvFn)}>${t('sa_download_csv_btn')}</button>
            <button class="btn btn-ghost" ${actionAttrs(pdfFn)}>${t('sa_download_pdf_btn')}</button>
        </div>`);
}
// Thin wrappers so the static buttons in index.html (which don't carry
// data-args) can each open the modal pre-scoped to their own roster.
function openStudentDownloadFormatModal() { openDownloadFormatModal('student'); }
function openTeacherDownloadFormatModal() { openDownloadFormatModal('teacher'); }

// Builds a CSV of the currently-filtered student roster and downloads it
// client-side (no server round-trip needed — ALL_STUDENTS is already
// loaded for the table/filters). Respects whatever the name/ID, class,
// section, and stream filters are currently set to, same as what's
// visible in the table, rather than always exporting the full roster.
function downloadStudentRosterCsv() {
    closeModal();
    const q = (document.getElementById('students-filter')?.value || '').trim().toLowerCase();
    const classVal = document.getElementById('students-class-filter')?.value || '';
    const sectionVal = document.getElementById('students-section-filter')?.value || '';
    const streamVal = document.getElementById('students-stream-filter')?.value || '';
    const statusVal = document.getElementById('students-status-filter')?.value || '';

    let list = statusVal ? ALL_STUDENTS.filter(s => s.status === statusVal) : ALL_STUDENTS.filter(s => !STUDENT_HIDDEN_BY_DEFAULT(s));
    if (q) {
        list = list.filter(s =>
            s.student_id.toLowerCase().includes(q) ||
            [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    if (classVal) list = list.filter(s => String(s.class_level) === String(classVal));
    if (sectionVal) list = list.filter(s => String(s.section) === String(sectionVal));
    // students.stream stores the long descriptive label directly
    // ('Natural Science'/'Social Science'), matching the filter's own
    // option values now — exact equality is correct here.
    if (streamVal) list = list.filter(s => String(s.stream) === String(streamVal));

    const headers = [t('sa_col_student_id'), t('sa_col_name'), t('sa_col_class'), t('sa_col_section'), t('sa_col_stream'), t('sa_col_fayda_number'), t('sa_col_status')];
    const rows = list.map(s => [
        csvField(s.student_id),
        csvField([s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ')),
        csvField(s.class_level ?? ''),
        csvField(s.section ?? ''),
        csvField(s.stream ?? ''),
        csvExcelSafeField(s.fayda_number || ''),
        csvField(s.status || '')
    ]);
    downloadCsv('student-roster.csv', headers, rows);
}

// PDF counterpart — server-rendered via puppeteer (see
// GET /api/admin/students/pdf), same window.open + cookie-auth pattern
// as the teacher roster PDF below.
function downloadStudentRosterPdf() {
    closeModal();
    window.open(`${API_BASE}/api/admin/students/pdf`, '_blank');
}

function filterStudentsTable() {
    const q = (document.getElementById('students-filter')?.value || '').trim().toLowerCase();
    const classVal = document.getElementById('students-class-filter')?.value || '';
    const sectionVal = document.getElementById('students-section-filter')?.value || '';
    const streamVal = document.getElementById('students-stream-filter')?.value || '';
    const statusVal = document.getElementById('students-status-filter')?.value || '';

    // Graduated/Transferred/Unregistered students live in their own tabs
    // (or aren't done registering for the year yet), so the main roster
    // hides them by default. Picking a specific status in the Status
    // filter overrides that and shows exactly that status instead.
    let list = statusVal ? ALL_STUDENTS.filter(s => s.status === statusVal) : ALL_STUDENTS.filter(s => !STUDENT_HIDDEN_BY_DEFAULT(s));
    if (q) {
        list = list.filter(s =>
            s.student_id.toLowerCase().includes(q) ||
            [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    if (classVal) list = list.filter(s => String(s.class_level) === String(classVal));
    if (sectionVal) list = list.filter(s => String(s.section) === String(sectionVal));
    // students.stream stores the long descriptive label directly
    // ('Natural Science'/'Social Science'), matching the filter's own
    // option values now — exact equality is correct here.
    if (streamVal) list = list.filter(s => String(s.stream) === String(streamVal));
    STUDENTS_FILTERED_LIST = list;
    STUDENTS_RENDER_LIMIT = STUDENTS_PAGE_SIZE;
    renderStudentsTable(list);
}

// Infinite scroll for the student roster: .main-content is the page's
// only real scroller (see its CSS comments), so this listens there
// rather than on the table itself, and only acts while the roster tab
// is actually the one showing — checked fresh on every scroll event
// since the same listener stays attached across tab/page switches.
function isStudentsRosterTabVisible() {
    const page = document.getElementById('page-students');
    const tab = document.getElementById('tab-students-roster');
    return !!page?.classList.contains('active') && tab?.style.display !== 'none';
}
function maybeLoadMoreStudentRows() {
    if (!isStudentsRosterTabVisible()) return;
    if (STUDENTS_RENDER_LIMIT >= STUDENTS_FILTERED_LIST.length) return;
    const main = document.querySelector('.main-content');
    const wrap = document.querySelector('#tab-students-roster .data-table-wrap');
    if (!main || !wrap) return;
    // Within ~300px of the bottom of the table's own wrapper (not the
    // whole document) is "near the bottom" — grow the window and
    // re-render once that's true.
    if (wrap.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom < 300) {
        STUDENTS_RENDER_LIMIT += STUDENTS_PAGE_SIZE;
        renderStudentsTable(STUDENTS_FILTERED_LIST);
    }
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
        // Long-form to match students.stream / pushed_reports.stream
        // (which now carries teacher_assignments.stream through, once
        // migrated) — same convention as updateStreamOptionsForLevel().
        streamSel.innerHTML = `
            <option value="">${t('sa_all_streams')}</option>
            <option value="Natural Science">${t('sa_stream_natural')}</option>
            <option value="Social Science">${t('sa_stream_social')}</option>`;
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
    tbody.innerHTML = `<tr><td colspan="6">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/principal/transfer-requests`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.full_name)}</td>
            <td>${r.class_level}-${r.section}</td>
            <td>${escapeHtml(r.reason || '—')}</td>
            <td>${transferRequestStatusBadge(r)}</td>
            <td>${formatEthDate(r.requested_at)}</td>
            <td>${r.status === 'pending'
                ? `<button class="btn btn-sm btn-success" ${actionAttrs('approveTransferRequest', [r.request_id])}>${t('sa_approve')}</button>
                   <button class="btn btn-sm btn-danger" ${actionAttrs('rejectTransferRequest', [r.request_id])}>${t('sa_reject')}</button>`
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
    if (!(await verifyAdminPassword())) return;

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
    if (!(await verifyAdminPassword())) return;
    const res = await apiFetch(`${API_BASE}/api/principal/transfer-requests/${request_id}/approve`, { method: 'POST' });
    await handleJsonResponse(res, t('sa_tr_approved_msg'));
    loadTransferRequests();
}

async function rejectTransferRequest(request_id) {
    if (!(await verifyAdminPassword())) return;
    const reason = await showPromptModal(t('sa_decline_reason_prompt')) || '';
    const res = await apiFetch(`${API_BASE}/api/principal/transfer-requests/${request_id}/reject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason })
    });
    await handleJsonResponse(res, t('sa_tr_rejected_msg'));
    loadTransferRequests();
}

// A transfer isn't "pending" on the Principal once it's been sent —
// it's sitting with the receiving school's Registrar. Only once the
// Registrar has actually completed their side does it become done, so
// the label reflects whose court it's in rather than a generic "pending".
function transferStatusBadge(status) {
    if (status === 'completed') return `<span class="badge badge-approved">${t('sa_transfer_complete')}</span>`;
    if (status === 'cancelled') return `<span class="badge badge-rejected">${t('sa_cancelled')}</span>`;
    return `<span class="badge badge-escalated">${t('sa_awaiting_registrar')}</span>`;
}

// ---------- Transferred Students (filterable by academic year) ----------
// Cache of the last-loaded rows, so the CSV export doesn't need its own
// round-trip — it just reuses whatever's already on screen for the
// selected year.
let TRANSFERRED_CACHE = [];
// null/'' = "Current Year" (the default option) — the server decides what
// that means (see GET /api/principal/transferred-students): normally just
// the current E.C. year, but while the semester is closed it also folds
// in the previous E.C. year, so nothing from the tail end of the year
// that just closed silently disappears from "this year"'s view. Anything
// else is a specific E.C. year picked from the dropdown.
let TRANSFERRED_SELECTED_YEAR = null;

async function loadTransferredStudents() {
    const tbody = document.getElementById('sa-transferred-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5">${t('sa_loading')}</td></tr>`;
    const url = TRANSFERRED_SELECTED_YEAR
        ? `${API_BASE}/api/principal/transferred-students?year=${encodeURIComponent(TRANSFERRED_SELECTED_YEAR)}`
        : `${API_BASE}/api/principal/transferred-students`;
    const res = await apiFetch(url);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_load_error')}</td></tr>`; return; }
    const { rows, years } = await res.json();
    TRANSFERRED_CACHE = rows;

    const yearSel = document.getElementById('transferred-year-filter');
    if (yearSel) {
        const selected = yearSel.value || TRANSFERRED_SELECTED_YEAR || '';
        // Options are E.C. years now (e.g. "2018", "2017"), not Gregorian
        // ones — "years" comes straight from the server's E.C.-bucketed
        // list. "Current Year" (value "") stays selectable on its own so
        // switching back to it re-applies the server's current+previous
        // default rather than pinning to whatever single year happened
        // to be selected before.
        yearSel.innerHTML = `<option value="">${t('sa_current_year')}</option>` +
            years.map(y => `<option value="${y}">${y}</option>`).join('');
        yearSel.value = selected;
    }

    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.full_name)}</td>
            <td>${r.class_level}-${r.section}</td>
            <td>${escapeHtml(r.transfer_code || '—')}</td>
            <td>${transferStatusBadge(r.transfer_status)}</td>
            <td>${formatEthDate(r.completed_at || r.initiated_at)}</td>
        </tr>`).join('');
}

function filterTransferredByYear() {
    TRANSFERRED_SELECTED_YEAR = document.getElementById('transferred-year-filter')?.value || null;
    loadTransferredStudents();
}

function openTransferredDownloadFormatModal() { openDownloadFormatModal('transferred'); }

function downloadTransferredCsv() {
    closeModal();
    const headers = [t('sa_col_name'), t('sa_col_class'), t('sa_col_transfer_code'), t('sa_col_status'), t('sa_col_date')];
    const rows = TRANSFERRED_CACHE.map(r => [
        csvField(r.full_name),
        csvField(`${r.class_level}-${r.section}`),
        csvField(r.transfer_code || ''),
        csvField(r.transfer_status || ''),
        csvField(formatEthDate(r.completed_at || r.initiated_at))
    ]);
    downloadCsv('transferred-students.csv', headers, rows);
}

function downloadTransferredPdf() {
    closeModal();
    // No TRANSFERRED_SELECTED_YEAR ("Current Year") -> no ?year= at all,
    // so the server applies its own current+previous-E.C.-year default
    // instead of this guessing at a Gregorian year that may not even
    // match what's on screen.
    const url = TRANSFERRED_SELECTED_YEAR
        ? `${API_BASE}/api/principal/transferred-students/pdf?year=${encodeURIComponent(TRANSFERRED_SELECTED_YEAR)}`
        : `${API_BASE}/api/principal/transferred-students/pdf`;
    window.open(url, '_blank');
}

// ---------- Graduation Batches (Registrar publishes; Principal reads,
// filterable by graduation year) ----------
let GRADUATION_CACHE = [];
let GRADUATION_SELECTED_BATCH = '';

async function loadGraduationBatches() {
    const tbody = document.getElementById('sa-batches-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="6">${t('sa_loading')}</td></tr>`;
    const url = GRADUATION_SELECTED_BATCH
        ? `${API_BASE}/api/principal/graduation-students?batch=${encodeURIComponent(GRADUATION_SELECTED_BATCH)}`
        : `${API_BASE}/api/principal/graduation-students`;
    const res = await apiFetch(url);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_load_error')}</td></tr>`; return; }
    const { rows, years } = await res.json();
    GRADUATION_CACHE = rows;

    const yearSel = document.getElementById('batches-year-filter');
    if (yearSel) {
        const selected = yearSel.value || GRADUATION_SELECTED_BATCH;
        yearSel.innerHTML = `<option value="">${t('sa_all_years')}</option>` + years.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join('');
        yearSel.value = selected;
    }

    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="6">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = rows.map(s => `
        <tr>
            <td>${escapeHtml(s.student_id)}</td>
            <td>${escapeHtml(s.full_name)}</td>
            <td>${escapeHtml(s.fayda_number || '—')}</td>
            <td>${escapeHtml(s.enrollment_year ?? '—')}</td>
            <td>${escapeHtml(s.graduation_year ?? '—')}</td>
            <td>${escapeHtml(s.status || '—')}</td>
        </tr>`).join('');
}

function filterGraduationByYear() {
    GRADUATION_SELECTED_BATCH = document.getElementById('batches-year-filter')?.value || '';
    loadGraduationBatches();
}

function openGraduationDownloadFormatModal() { openDownloadFormatModal('graduation'); }

function downloadGraduationCsv() {
    closeModal();
    const headers = [t('sa_col_student_id'), t('sa_col_name'), t('sa_col_fayda_number'), t('sa_col_enrollment_year'), t('sa_col_graduation_year'), t('sa_col_status')];
    const rows = GRADUATION_CACHE.map(s => [
        csvField(s.student_id),
        csvField(s.full_name),
        csvExcelSafeField(s.fayda_number || ''),
        csvField(s.enrollment_year ?? ''),
        csvField(s.graduation_year ?? ''),
        csvField(s.status || '')
    ]);
    downloadCsv('graduate-roster.csv', headers, rows);
}

function downloadGraduationPdf() {
    closeModal();
    const url = GRADUATION_SELECTED_BATCH
        ? `${API_BASE}/api/principal/graduation-students/pdf?batch=${encodeURIComponent(GRADUATION_SELECTED_BATCH)}`
        : `${API_BASE}/api/principal/graduation-students/pdf`;
    window.open(url, '_blank');
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
        // Long-form values ('Natural Science'/'Social Science') to match
        // students.stream/class_sections.stream, which the Registrar
        // portal already writes this way — subjects.stream and
        // teacher_assignments.stream (set from this form) are being
        // migrated to the same convention so every stream column in the
        // system stores one consistent value instead of two.
        streamSelect.innerHTML = `
            <option value="Natural Science">${t('sa_stream_natural')}</option>
            <option value="Social Science">${t('sa_stream_social')}</option>`;
        streamSelect.value = 'Natural Science';
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
            <button type="button" class="btn btn-sm btn-ghost" ${actionAttrs('clearTeacherSelection', [hiddenId, resultsId])}>${t('sa_teacher_change')}</button>
        </div>`;
}

// "Change" button for a picked teacher: clears the hidden id field and
// the results panel so the search box is ready for a new pick.
function clearTeacherSelection(hiddenId, resultsId) {
    document.getElementById(hiddenId).value = '';
    document.getElementById(resultsId).innerHTML = '';
}

// ---------- Utility ----------
function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Small circular avatar for table rows (student roster / teacher roster
// ID cells) — a real photo when one's on file, otherwise initials on a
// solid background so every row still has *something* to visually
// anchor on rather than blank space next to the ID. Pass
// { previewable: true } (used for the student roster's ID photo) to make
// an on-file photo clickable, opening a larger preview via previewIdPhoto.
function tableAvatarHtml(name, photoUrl, { previewable = false } = {}) {
    const initials = String(name || '').trim().split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
    if (!photoUrl) return `<span class="table-avatar">${escapeHtml(initials)}</span>`;
    const fullUrl = API_BASE + photoUrl;
    const img = `<img src="${escapeHtml(fullUrl)}" alt="" loading="lazy" />`;
    if (previewable) {
        return `<span class="table-avatar table-avatar-clickable" ${actionAttrs('previewIdPhoto', [fullUrl, name])}>${img}</span>`;
    }
    return `<span class="table-avatar">${img}</span>`;
}

// Full-size preview of a roster ID photo, opened by clicking the small
// avatar in the table (see tableAvatarHtml's previewable option) — the
// photo shown is specifically the one uploaded/approved for the ID card
// (id_photo_url), not any other profile picture.
function previewIdPhoto(fullUrl, name) {
    openModal(`
        <h3>${escapeHtml(name || '')}</h3>
        <div class="id-photo-preview-wrap">
            <img src="${escapeHtml(fullUrl)}" alt="" class="id-photo-preview-img" />
        </div>
        <div class="form-actions" style="margin-top: 14px;">
            <button class="btn btn-ghost" ${actionAttrs('closeModal', [])}>${t('sa_close')}</button>
        </div>
    `);
}

// ---------- Action dispatch (replaces inline onclick="...") ----------
// Rows rendered from server data used to build ${actionAttrs('fn', [value])} by
// hand-concatenating server data straight into an HTML attribute string.
// Any value containing a stray quote (a name, a subject, free-text a
// teacher typed) could break out of the attribute early and inject
// arbitrary markup/script — a real DOM XSS hole, not just a style
// nitpick. actionAttrs() replaces that pattern: it JSON-encodes the
// arguments and HTML-escapes the result before it ever lands in a
// template string, so no value can end the attribute early no matter
// what characters it contains. Splice the result straight into a
// template literal in place of an onclick="...": `${actionAttrs('foo',
// [a, b])}`. The matching delegated 'click' listener near the bottom of
// this file reads data-action/data-args back off the clicked element and
// calls the real function with the decoded arguments.
function actionAttrs(action, args = []) {
    return `data-action="${escapeHtml(action)}" data-args="${escapeHtml(JSON.stringify(args))}"`;
}
// ==========================================================
// TEACHER SETUP, Stage 1 (Principal) — incoming from Zonal + direct local hire
// ==========================================================
async function loadTeacherSetup() {
    loadIncomingTeachers();

    const tbody = document.getElementById('sa-teacher-setup-tbody');
    tbody.innerHTML = `<tr><td colspan="7">${t('sa_loading')}</td></tr>`;
    const res = await apiFetch(`${API_BASE}/api/admin/teachers`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="7">${t('sa_load_error')}</td></tr>`; return; }
    const teachers = await res.json();
    TEACHER_ROSTER_CACHE = teachers;
    if (teachers.length === 0) { tbody.innerHTML = `<tr><td colspan="7">${t('sa_no_data')}</td></tr>`; return; }
    tbody.innerHTML = teachers.map(tr => `
        <tr>
            <td class="table-id-cell">${tableAvatarHtml(tr.full_name, tr.avatar_url, { previewable: true })}<span>${escapeHtml(tr.teacher_id)}</span></td>
            <td>${escapeHtml(tr.full_name)}</td>
            <td>${escapeHtml(tr.contact_number || '—')}</td>
            <td>${escapeHtml(tr.education_level || '—')}</td>
            <td>${escapeHtml(tr.fayda_number || '—')}</td>
            <td>${tr.awaiting_assignment
                ? `<span class="badge badge-pending">${t('sa_awaiting_assignment')}</span>`
                : `<span class="badge badge-approved">${tr.assignment_count} ${t('sa_assignments_lower')}</span>`}</td>
            <td><button class="btn btn-sm btn-ghost" ${actionAttrs('openEditTeacherRosterModal', [tr.teacher_id])}>${t('sa_edit')}</button></td>
        </tr>`).join('');
}

// Cache of the last-loaded roster rows, so the edit modal can prefill
// from what's already on screen instead of a fresh round-trip.
let TEACHER_ROSTER_CACHE = [];

// Deliberately narrow edit surface — just the three fields the roster
// table shows that aren't set elsewhere (contact, education level,
// Fayda/national-ID number). Name/school/login live in Teacher Audit /
// Teacher Transfer, not here.
function openEditTeacherRosterModal(teacher_id) {
    const tr = TEACHER_ROSTER_CACHE.find(x => x.teacher_id === teacher_id);
    if (!tr) return;
    const levels = ['TVET / College Diploma', "Bachelor's Degree", "Master's Degree", 'PhD / Doctoral Degree'];
    openModal(`
        <h3>${t('sa_edit_teacher_heading')} \u2014 ${escapeHtml(tr.full_name)} (${teacher_id})</h3>
        <div class="form-group">
            <label>${t('sa_col_contact')}</label>
            <input type="text" id="et-contact" value="${escapeHtml(tr.contact_number || '')}" />
        </div>
        <div class="form-group">
            <label>${t('sa_col_education_level')}</label>
            <select id="et-education-level">
                <option value="">\u2014</option>
                ${levels.map(l => `<option value="${escapeHtml(l)}" ${tr.education_level === l ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>${t('sa_col_fayda_number')}</label>
            <input type="text" id="et-fayda" inputmode="numeric" maxlength="16" pattern="\\d{16}"
                   value="${escapeHtml(tr.fayda_number || '')}" placeholder="${t('sa_fayda_placeholder')}" />
            <span class="form-hint">${t('sa_fayda_hint')}</span>
        </div>
        <div class="form-actions">
            <button class="btn btn-accent" ${actionAttrs('saveTeacherRosterEdit', [teacher_id])}>${t('sa_save')}</button>
            <button class="btn btn-ghost" ${actionAttrs('closeModal', [])}>${t('sa_close')}</button>
        </div>
    `);
    // Digits only, capped at 16 as the person types — matches the
    // "16 digit limited" requirement directly in the input, on top of
    // the server-side format check.
    document.getElementById('et-fayda').addEventListener('input', e => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 16);
    });
}

async function saveTeacherRosterEdit(teacher_id) {
    const contact_number = document.getElementById('et-contact').value.trim();
    const education_level = document.getElementById('et-education-level').value;
    const fayda_number = document.getElementById('et-fayda').value.trim();
    if (fayda_number && fayda_number.length !== 16) {
        return showToast(t('sa_fayda_hint'), 'error');
    }
    if (!(await verifyAdminPassword())) return;
    const res = await apiFetch(`${API_BASE}/api/admin/teachers/${teacher_id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_number: contact_number || null, education_level: education_level || null, fayda_number: fayda_number || null })
    });
    const data = await handleJsonResponse(res, t('sa_teacher_updated'));
    if (!data) return;
    closeModal();
    loadTeacherSetup();
}

// CSV counterpart to the PDF below — built client-side from
// TEACHER_ROSTER_CACHE (already loaded for the table), same columns as
// the PDF (Teacher ID, Name, Contact, Level of Education, Fayda Number,
// Teaching Load). Contact Number and Fayda Number both go through
// csvExcelSafeField since either can be a long/leading-zero digit
// string that a spreadsheet app would otherwise mangle.
function downloadTeacherRosterCsv() {
    closeModal();
    const headers = [t('sa_col_teacher_id'), t('sa_col_name'), t('sa_col_contact'), t('sa_col_education_level'), t('sa_col_fayda_number'), t('sa_col_status')];
    const rows = TEACHER_ROSTER_CACHE.map(tr => [
        csvField(tr.teacher_id),
        csvField(tr.full_name),
        csvExcelSafeField(tr.contact_number || ''),
        csvField(tr.education_level || ''),
        csvExcelSafeField(tr.fayda_number || ''),
        csvField(tr.awaiting_assignment ? t('sa_awaiting_assignment') : `${tr.assignment_count} ${t('sa_assignments_lower')}`)
    ]);
    downloadCsv('teacher-roster.csv', headers, rows);
}

// Opens a printable roster PDF (Teacher ID, Name, Contact, Level of
// Education, Fayda Number, Teaching Load) — same window.open +
// cookie-auth pattern as the other PDF downloads in this app (see
// printAnalysisReport / downloadTtWeek above).
function downloadTeacherRosterPdf() {
    closeModal();
    window.open(`${API_BASE}/api/admin/teachers/pdf`, '_blank');
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
                ? `<button class="btn btn-sm btn-success" ${actionAttrs('openAcceptIncomingModal', [r.incoming_id])}>${t('sa_accept')}</button>
                   <button class="btn btn-sm btn-danger" ${actionAttrs('declineIncomingTeacher', [r.incoming_id])}>${t('sa_decline')}</button>`
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
            <div class="password-prompt-field-wrap">
                <span class="password-prompt-field-icon">${lucideIcon('lock', 16)}</span>
                <input type="text" id="accept-incoming-password" class="password-prompt-field" value="1122" />
            </div>
        </div>
        <div class="form-actions">
            <button class="btn btn-accent" ${actionAttrs('acceptIncomingTeacher', [incoming_id])}>${t('sa_accept')}</button>
            <button class="btn btn-ghost" ${actionAttrs('closeModal', [])}>${t('sa_close')}</button>
        </div>
    `);
}

async function acceptIncomingTeacher(incoming_id) {
    const password = document.getElementById('accept-incoming-password').value.trim();
    if (!password) return showToast(t('sa_err_teacher_setup_required'), 'error');
    if (!(await verifyAdminPassword())) return;
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
    if (!(await verifyAdminPassword())) return;
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
    tbody.innerHTML = `<tr><td colspan="5">${t('sa_loading')}</td></tr>`;
    const teacherIdFilter = filterTeacherId || filterSelect?.value || '';
    const url = teacherIdFilter
        ? `${API_BASE}/api/academic-vp/teacher-assignments?teacher_id=${encodeURIComponent(teacherIdFilter)}`
        : `${API_BASE}/api/academic-vp/teacher-assignments`;
    const res = await apiFetch(url);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_load_error')}</td></tr>`; return; }
    const rows = await res.json();
    if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="5">${t('sa_no_data')}</td></tr>`; return; }

    // Group rows so a teacher covering 9A/9B/9C for the same subject is one
    // line with a row of section tick-boxes, rather than three separate
    // rows repeating the teacher/subject/class over and over.
    const groups = new Map();
    for (const r of rows) {
        const key = `${r.teacher_id}|${r.subject_id}|${r.class_level}|${r.stream || ''}`;
        if (!groups.has(key)) {
            groups.set(key, {
                teacher_id: r.teacher_id, teacher_name: r.teacher_name,
                subject_id: r.subject_id, subject_name: r.subject_name,
                class_level: r.class_level, stream: r.stream,
                sections: new Set()
            });
        }
        groups.get(key).sections.add(r.section);
    }

    tbody.innerHTML = [...groups.values()].map(g => {
        // All sections that exist for this class level (+ stream, if any),
        // so the tick row shows the full set — not just the ones assigned.
        let available = TA_CLASS_SECTIONS_CACHE.filter(s => String(s.class_level) === String(g.class_level));
        if (g.stream) available = available.filter(s => !s.stream || normalizeStreamCode(s.stream) === normalizeStreamCode(g.stream));
        const sectionNames = new Set(available.map(s => s.section_name));
        // Guard against a legacy assignment whose section isn't in the
        // current class_sections config — still show it, ticked.
        g.sections.forEach(s => sectionNames.add(s));

        const boxes = [...sectionNames].sort().map(name => {
            const assigned = g.sections.has(name);
            const disabledAttr = (canAssign && assigned) ? '' : 'disabled';
            const interactive = canAssign && assigned;
            const clickHandler = interactive
                ? `${actionAttrs('unassignTeacherSection', [g.teacher_id, g.class_level, name, g.subject_id])}`
                : '';
            return `<label class="ta-section-tick${assigned ? ' is-assigned' : ''}" title="${escapeHtml(name)}" ${clickHandler}>
                <input type="checkbox" ${assigned ? 'checked' : ''} ${disabledAttr} tabindex="-1">
                <span>${escapeHtml(name)}</span>
            </label>`;
        }).join('');

        return `
        <tr>
            <td>${escapeHtml(g.teacher_name)} (${escapeHtml(g.teacher_id)})</td>
            <td>${escapeHtml(g.subject_name)}</td>
            <td>${escapeHtml(g.class_level)}</td>
            <td>${escapeHtml(g.stream || '—')}</td>
            <td><div class="ta-section-ticks">${boxes}</div></td>
        </tr>`;
    }).join('');

    renderTeacherRoles(teachers, canAssign);
}

// Clicking a ticked (assigned) section box removes the teacher from just
// that section — the boxes double as the remove control, so there's no
// separate long "Remove" button per row. Gated behind a password like
// every other assign/remove action (see removeTeacherAssignment).
async function unassignTeacherSection(teacher_id, class_level, section, subject_id) {
    await removeTeacherAssignment(teacher_id, class_level, section, subject_id);
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
            <td>${escapeHtml(tr.full_name)} (${escapeHtml(tr.teacher_id)})</td>
            <td>${tr.homeroom
                ? `${tr.homeroom.class_level}-${tr.homeroom.section}${tr.homeroom.stream ? ' (' + escapeHtml(tr.homeroom.stream) + ')' : ''}`
                : `<span class="badge badge-none">${t('sa_none')}</span>`}</td>
            <td>${tr.is_registrar
                ? `<span class="badge badge-approved">${t('sa_registrar_active')}</span>`
                : `<span class="badge badge-none">${t('sa_none')}</span>`}</td>
            <td>${canAssign ? `
                ${tr.homeroom ? `<button class="btn btn-sm btn-danger" ${actionAttrs('removeTeacherHomeroom', [tr.teacher_id])}>${t('sa_remove')}</button>` : ''}
                ${!tr.is_registrar
                    ? `<button class="btn btn-sm btn-ghost" ${actionAttrs('grantRegistrar', [tr.teacher_id])}>${t('sa_grant_registrar_btn')}</button>`
                    : `<button class="btn btn-sm btn-danger" ${actionAttrs('revokeRegistrar', [tr.teacher_id])}>${t('sa_revoke_registrar_btn')}</button>`}
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
    if (!(await verifyAdminPassword())) return;

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
    if (!(await showConfirmModal(t('sa_confirm_remove_homeroom'), { danger: true }))) return;
    if (!(await verifyAdminPassword())) return;
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
    if (!(await verifyAdminPassword())) return;
    const res = await apiFetch(`${API_BASE}/api/academic-vp/grant-registrar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id })
    });
    await handleJsonResponse(res, t('sa_registrar_granted'));
    loadTeacherAssignments();
}

async function revokeRegistrar(teacher_id) {
    if (!(await showConfirmModal(t('sa_revoke_registrar_confirm'), { danger: true }))) return;
    if (!(await verifyAdminPassword())) return;
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

    const levels = [...new Set(TA_CLASS_SECTIONS_CACHE.map(s => String(s.class_level)))]
        .sort((a, b) => Number(a) - Number(b));
    ['ta-class-level', 'hr-class-level'].forEach(id => {
        const levelSelect = document.getElementById(id);
        if (!levelSelect) return;
        const current = levelSelect.value;
        levelSelect.innerHTML = `<option value="">${t('sa_select_class_level')}</option>`
            + levels.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
        if (levels.includes(current)) levelSelect.value = current;
    });
    renderTaSectionCheckboxes();
    renderHrSectionOptions();
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

// Same Registrar-configured sections as above, but for the Assign
// Homeroom form's single Section dropdown — a homeroom is exactly one
// section, so this is a <select>, not tick-boxes, but it's built from
// the same TA_CLASS_SECTIONS_CACHE and the same normalizeStreamCode
// bridge so it can never offer a section the Registrar didn't set up.
function renderHrSectionOptions() {
    const select = document.getElementById('hr-section');
    if (!select) return;
    const level = document.getElementById('hr-class-level')?.value || '';
    const stream = document.getElementById('hr-stream')?.value || '';
    if (!level) {
        select.innerHTML = `<option value="">${t('sa_select_section')}</option>`;
        return;
    }
    let sections = TA_CLASS_SECTIONS_CACHE.filter(s => String(s.class_level) === String(level));
    if (stream) sections = sections.filter(s => !s.stream || normalizeStreamCode(s.stream) === normalizeStreamCode(stream));
    const names = [...new Set(sections.map(s => s.section_name))].sort();
    const current = select.value;
    select.innerHTML = names.length
        ? (`<option value="">${t('sa_select_section')}</option>` + names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join(''))
        : `<option value="">${t('sa_no_data')}</option>`;
    if (names.includes(current)) select.value = current;
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
    if (!(await verifyAdminPassword())) return;

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
    if (!(await showConfirmModal(t('sa_confirm_remove_assignment'), { danger: true }))) return;
    if (!(await verifyAdminPassword())) return;
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
        <tr style="cursor:pointer; ${tr.flagged ? 'background:var(--danger-bg);' : ''}" ${actionAttrs('openTeacherAuditModal', [tr.teacher_id])}>
            <td>${escapeHtml(tr.full_name)} (${escapeHtml(tr.teacher_id)})</td>
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
            <button class="btn btn-ghost" ${actionAttrs('closeModal', [])}>${t('sa_close')}</button>
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
            <div class="password-prompt">
                <div class="password-prompt-icon">${lucideIcon('lock', 20)}</div>
                <h3>${escapeHtml(message)}</h3>
                <div class="password-prompt-field-wrap">
                    <span class="password-prompt-field-icon">${lucideIcon('lock', 16)}</span>
                    <input id="sa-password-prompt-field" class="form-control password-prompt-field" type="password" autocomplete="current-password" placeholder="${t('sa_password_placeholder')}">
                    <button type="button" class="password-prompt-toggle" id="sa-password-prompt-toggle" aria-label="${t('sa_show_password')}" tabindex="-1">${lucideIcon('eye', 17)}</button>
                </div>
            </div>
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
        const toggleBtn = document.getElementById('sa-password-prompt-toggle');
        toggleBtn.onclick = () => {
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            toggleBtn.innerHTML = lucideIcon(showing ? 'eye' : 'eye-off', 17);
            toggleBtn.setAttribute('aria-label', t(showing ? 'sa_show_password' : 'sa_hide_password'));
        };
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
            <button class="btn btn-ghost" ${actionAttrs('closeModal', [])} data-i18n="sa_close">${t('sa_close')}</button>
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
        <div class="msg-row${unread ? ' unread' : ''}" data-id="${m.message_id}" ${actionAttrs('selectMessage', [m.message_id])}>
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
            ${!m.is_read && box === 'inbox' ? `<button class="btn btn-sm btn-ghost" ${actionAttrs('markMessageRead', [m.message_id])}>${t('sa_mark_read')}</button>` : ''}
            ${box === 'inbox' ? `<button class="btn btn-sm btn-primary" ${actionAttrs('replyToMessage', [m.sender_type, m.sender_id, m.subject || ''])}>${t('sa_reply_btn')}</button>` : ''}
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
        <div class="msg-row${th.unread_count > 0 ? ' unread' : ''}" ${actionAttrs('openContactThreadModal', [th.thread_id])}>
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
        <div class="form-actions"><button class="btn btn-ghost" ${actionAttrs('closeModal', [])}>${t('sa_close')}</button></div>`);
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
            <button class="btn btn-accent btn-sm" ${actionAttrs('replyToContactThread', [thread_id])}>${t('sa_reply_btn')}</button>
            <button class="btn ${thread.status === 'Resolved' ? 'btn-ghost' : 'btn-success'} btn-sm" ${actionAttrs('toggleContactThreadStatus', [thread_id, thread.status === 'Resolved' ? 'Open' : 'Resolved'])}>
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
    // Principal Stamp — unlike Signature and ID Photo (which every admin
    // title keeps for their own use), the stamp is only meaningful for
    // whoever is authorized to actually stamp official documents: the
    // Principal. Academic VP / Admin VP don't get the card at all (not
    // just a locked/read-only version, like the School Seal below —
    // this one shouldn't be visible to them in the first place).
    const stampCard = document.getElementById('profile-stamp-card');
    if (stampCard) stampCard.style.display = (CURRENT_TITLE === 'Principal') ? '' : 'none';

    const res = await apiFetch(`${API_BASE}/api/admin/document-status`);
    if (!res.ok) return;
    const data = await res.json();
    const sigPreview = document.getElementById('profile-signature-preview');
    const stampPreview = document.getElementById('profile-stamp-preview');
    if (data.signature_url) {
        sigPreview.src = API_BASE + data.signature_url; sigPreview.style.display = '';
        document.getElementById('profile-signature-placeholder').style.display = 'none';
    }
    if (data.stamp_url && CURRENT_TITLE === 'Principal') {
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
    // Falls back to the placeholder avatar if the photo URL fails to load
    // (404, network error, etc). Moved here from an inline onerror="..."
    // attribute in index.html — this portal's CSP (script-src-attr 'none',
    // see helmet() in server.js) blocks that from ever executing.
    if (photo) {
        photo.onerror = () => {
            photo.style.display = 'none';
            if (placeholder) placeholder.style.display = 'flex';
        };
    }
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

function flipIdCard() {
    const flipper = document.getElementById('idcard-flipper');
    if (flipper) flipper.classList.toggle('idcard-flipped');
}

function printIdCard() {
    window.print();
}

// ---------- Delegated click dispatch for data-action elements ----------
// Central lookup from the string in data-action (set by actionAttrs, or
// hand-written on static buttons in index.html) to the real function.
// Function declarations are hoisted, so it doesn't matter that some of
// these are defined earlier in the file and some later — by the time a
// click actually happens, every one of them exists.
const ACTION_HANDLERS = {
    acceptIncomingTeacher, approveTransferRequest, clearTeacherSelection, closeModal,
    decideCase, decideDocumentRequest, decideDropoutRequest, decidePenalty,
    decideStudentAbsence, decideSubjectEntryRequest, decideTeacherAbsence, declineIncomingTeacher,
    grantRegistrar, issueAward, markMessageRead, navigateToPage,
    openAcceptIncomingModal, openContactThreadModal, openEditTeacherRosterModal,
    openTeacherAuditModal, rejectTransferRequest, removeTeacherHomeroom, reopenMarksReport,
    replyToContactThread, replyToMessage, revokeRegistrar, saveTeacherRosterEdit,
    saveTtGrid, selectMessage, toggleContactThreadStatus, unassignTeacherSection,
    openStudentsOnLeaveModal, flipIdCard, printIdCard,
    openDownloadFormatModal, openStudentDownloadFormatModal, openTeacherDownloadFormatModal,
    openTransferredDownloadFormatModal, openGraduationDownloadFormatModal,
    downloadStudentRosterCsv, downloadStudentRosterPdf, downloadTeacherRosterCsv, downloadTeacherRosterPdf,
    downloadTransferredCsv, downloadTransferredPdf, downloadGraduationCsv, downloadGraduationPdf,
    previewIdPhoto
};

document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const handler = ACTION_HANDLERS[action];
    if (!handler) {
        console.error('Unknown data-action:', action);
        return;
    }
    // Every data-action element replaces what used to be either an
    // onclick="...; return false;" on an <a href="#">, or an
    // onclick="event.preventDefault(); ..." on a <label> wrapping a
    // checkbox — both were suppressing the element's default click
    // behavior. Doing it here once covers both cases identically.
    e.preventDefault();
    let args = [];
    if (el.dataset.args) {
        try { args = JSON.parse(el.dataset.args); } catch (err) { console.error('Bad data-args JSON:', err); }
    }
    handler(...args);
});

// ---------- Students table sticky header offset ----------
// #page-students opts its table thead out of the shared
// `table.data-table thead th { position: sticky; top: 70px }` rule
// (see styles.css) because this page's own sticky header block
// (title + stat cards + tabs, wrapped in .page-sticky-header) is taller
// than the plain 70px topbar every other page sticks under — reusing
// top:70px here would land the frozen column header underneath/behind
// that block instead of right beneath it.
// This measures the actual rendered height of that block (its stat
// row loads in asynchronously, so the height isn't known up front) and
// exposes it as a CSS custom property so the thead can stick flush
// beneath it. A ResizeObserver keeps it in sync if that content
// reflows (e.g. language switch changing text length/line count).
// ---------- Global sticky header/filter-bar/thead offsets ----------
// Generic, page-agnostic version of what used to be a #page-students-
// only fix: ANY page can stack a .page-sticky-header (title/stat-cards/
// tabs) and/or a .sticky-filter-bar (filter dropdowns/search/buttons)
// above its table, and both need their own measured offset since their
// heights aren't known up front (a stat row can load in asynchronously,
// and filter-bar height can vary with wrapped filters on narrow
// screens). This measures whichever of those blocks are actually
// present and visible on the CURRENTLY ACTIVE page/tab and exposes two
// CSS custom properties consumed by styles.css:
//   --sticky-header-offset  — where .sticky-filter-bar sticks (topbar +
//                              page header, if any)
//   --sticky-content-offset — where table.data-table thead sticks
//                              (the above + filter bar, if any)
// A page with neither block simply gets both vars equal to the topbar's
// own height, which is the plain "thead sticks right under the topbar"
// behavior every ordinary page already had. Call this any time the
// active page/tab changes, or when something inside the header/filter
// bar might have resized (a ResizeObserver on those elements handles
// the latter automatically — see the DOMContentLoaded wiring below).
function updateStickyOffsets() {
    // Use the top-bar's actual measured height rather than assuming its
    // usual ~70px — on narrow/mobile widths it wraps onto 2-3 rows (see
    // updateTopbarHeightVar below), and stacking sticky blocks under a
    // stale 70px guess is what lets them drift out of sync with it.
    const topbar = document.querySelector('.top-bar');
    const topbarHeight = topbar?.offsetHeight || 70;

    const activePage = document.querySelector('.page-content.active');
    const header = activePage?.querySelector('.page-sticky-header');
    const headerOffset = topbarHeight + (header?.offsetHeight || 0);
    document.documentElement.style.setProperty('--sticky-header-offset', `${headerOffset}px`);

    // Only the currently-visible filter bar counts — a page can have one
    // per tab (e.g. #page-students' Roster/Transferred/Batches tabs),
    // but only one tab-panel is ever shown at a time. offsetHeight is 0
    // for a display:none ancestor, so an explicit visibility check isn't
    // even required, but .closest('.tab-panel') keeps intent obvious.
    const filterBar = activePage
        ? [...activePage.querySelectorAll('.sticky-filter-bar, .sa-students-toolbar')]
            .find(el => el.offsetParent !== null)
        : null;
    document.documentElement.style.setProperty('--sticky-content-offset', `${headerOffset + (filterBar?.offsetHeight || 0)}px`);
}

// The top-bar itself wraps onto extra rows below ~900px (title/meta on
// one row, badges on another, language/icons/profile on a third — see
// the .top-bar comment in styles.css), so its real height isn't the
// fixed 70px every sticky block under it used to assume. This measures
// it and exposes it as --topbar-height so .page-sticky-header (and, via
// updateStickyOffsets above, any page's filter bar/thead) can stick at
// the top-bar's actual bottom edge at any width instead of a stale
// guess that would leave rows hidden behind (or a gap below) it.
function updateTopbarHeightVar() {
    const topbar = document.querySelector('.top-bar');
    if (!topbar) return;
    document.documentElement.style.setProperty('--topbar-height', `${topbar.offsetHeight}px`);
}

// ---------- Static nav/header buttons (moved out of index.html's
// inline onclick="..." attributes and into listeners here) ----------
document.addEventListener('DOMContentLoaded', () => {
    const topbarEl = document.querySelector('.top-bar');
    if (topbarEl) {
        updateTopbarHeightVar();
        if (window.ResizeObserver) {
            new ResizeObserver(updateTopbarHeightVar).observe(topbarEl);
        }
        window.addEventListener('resize', updateTopbarHeightVar);
    }
    // Global sticky offsets (see updateStickyOffsets() above): observe
    // EVERY .page-sticky-header / .sticky-filter-bar in the document —
    // not just one page's — since any page can use either class now.
    // Only the active page's own elements actually affect the computed
    // vars, but it's cheap and simple to just watch them all rather than
    // re-wiring observers every time the active page changes.
    updateStickyOffsets();
    if (window.ResizeObserver) {
        const stickyRO = new ResizeObserver(updateStickyOffsets);
        document.querySelectorAll('.page-sticky-header, .sticky-filter-bar, .sa-students-toolbar')
            .forEach(el => stickyRO.observe(el));
        // Also re-measure whenever the top-bar itself changes height
        // (e.g. its badges wrap differently after a language switch
        // changes their text length) — updateStickyOffsets reads the
        // top-bar's live height each time, but it only runs when
        // something triggers it.
        if (topbarEl) stickyRO.observe(topbarEl);
    }
    window.addEventListener('resize', updateStickyOffsets);
    // Infinite scroll for the (potentially long) student roster table —
    // see maybeLoadMoreStudentRows above for the visibility/proximity
    // checks that keep this a no-op outside the Roster tab.
    document.querySelector('.main-content')?.addEventListener('scroll', maybeLoadMoreStudentRows);
    document.querySelectorAll('.lang-switch-btn[data-lang]').forEach(btn => {
        btn.addEventListener('click', () => setLang(btn.dataset.lang));
    });
    document.querySelectorAll('[data-file-input-target]').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(btn.dataset.fileInputTarget);
            if (input) input.click();
        });
    });
    const flipBtn = document.getElementById('idcard-flip-btn');
    if (flipBtn) flipBtn.addEventListener('click', flipIdCard);
    const printBtn = document.getElementById('idcard-print-btn');
    if (printBtn) printBtn.addEventListener('click', printIdCard);

    // Timetable grid's subject dropdowns are regenerated wholesale on
    // every generateTtGrid() call, but this wrapping container isn't —
    // delegating from here (rather than an onchange="..." baked into
    // each <select> string) means the listener survives every
    // regeneration without needing to be re-wired.
    document.getElementById('tt-grid-wrap')?.addEventListener('change', (e) => {
        if (e.target.matches('.tt-grid-cell')) onTtCellChange(e.target.id);
    });
});