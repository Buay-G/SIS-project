// CONFIG
const API_BASE = 'http://localhost:3001';

// Every request needs credentials: 'include' so the httpOnly auth cookie
// set at login is actually sent along. Routing every call through this
// wrapper means that's never something to remember (or forget) at each
// individual apiFetch() call site.
function apiFetch(url, options = {}) {
    return fetch(url, { ...options, credentials: 'include' });
}

// Identity is no longer read from localStorage — the real session lives
// in an httpOnly cookie that this script can't see or read by design.
let CURRENT_TEACHER_ID = null;
let CURRENT_SCHOOL_ID = null;
let CURRENT_SCHOOL_NAME = null;

// i18n.js calls this after every language switch so JS-rendered content
// (built with t() at fetch time, not data-i18n attributes) gets redrawn
// in the new language too — data-i18n elements are already handled by
// i18n.js's own applyTranslations().
window.onSisLangChange = () => {
    if (teacherIdCardData) renderTeacherIdCard(teacherIdCardData);
    if (lastPerformanceCompletion) renderPerformanceCompletion(lastPerformanceCompletion);
    if (lastDashboardTextbookData) renderDashboardTextbookSummary(lastDashboardTextbookData);
    if (lastTodaysClasses) renderDashboardTodaysClasses(lastTodaysClasses);
    if (lastStudentPerformance) renderDashboardStudentPerformance(lastStudentPerformance);
    if (lastSemesterStatus) renderSemesterStatusBadge(lastSemesterStatus);
    if (lastMyClassRoster) renderMyClassRoster(lastMyClassRoster);
    if (conductData && conductData.length > 0) {
        populateConductSectionFilter(conductData);
        renderConductList(conductData);
    }
};

async function checkAuthAndInit() {
    try {
        const res = await apiFetch(`${API_BASE}/api/me`);
        if (!res.ok) { window.location.href = '/login.html'; return false; }
        const data = await res.json();

        if (data.role !== 'teachers') {
            window.location.href = '/login.html';
            return false;
        }

        CURRENT_TEACHER_ID = data.user_id;
        CURRENT_SCHOOL_ID = data.school_id;
        CURRENT_SCHOOL_NAME = data.school_name;

        // Update both the top-bar title and the sidebar logo subtitle
        if (CURRENT_SCHOOL_NAME) {
            const titleEl = document.getElementById('page-title-text');
            if (titleEl) titleEl.textContent = CURRENT_SCHOOL_NAME;
            const logoEl = document.getElementById('nav-school-name');
            if (logoEl) logoEl.textContent = CURRENT_SCHOOL_NAME;
        }

        // Show the school's logo in the nav header automatically once a
        // zonal/school admin has uploaded one (POST /api/admin/school-logo)
        // — nothing for the teacher to configure, it just appears.
        const schoolLogoEl = document.getElementById('nav-school-logo');
        if (schoolLogoEl) {
            if (data.logo_url) {
                schoolLogoEl.src = data.logo_url;
                schoolLogoEl.alt = CURRENT_SCHOOL_NAME ? `${CURRENT_SCHOOL_NAME} logo` : "School logo";
                schoolLogoEl.style.display = 'block';
            } else {
                schoolLogoEl.style.display = 'none';
            }
        }

        const moeBadge = document.getElementById('moe-code-badge');
        if (moeBadge) {
            if (data.moe_school_code) {
                moeBadge.textContent = `MOE: ${data.moe_school_code}`;
                moeBadge.style.display = 'inline-flex';
            } else {
                moeBadge.style.display = 'none';
            }
        }

        if (data.additional_role === 'registrar') {
            const item = document.getElementById('nav-registrar-item');
            if (item) item.style.display = 'block';
        }

        return true;
    } catch (err) {
        console.error("Auth check failed:", err);
        window.location.href = '/login.html';
        return false;
    }
}

// INIT — single DOMContentLoaded, every loader called once
document.addEventListener('DOMContentLoaded', async () => {
    const authed = await checkAuthAndInit();
    if (!authed) return;

    await Promise.all([
        loadStudents(),
        loadSubjects(),
        loadProfileData(),
        loadDashboardPerformance(),
        loadConductStatus(),
        loadPushStatus(),
        loadHomeroomInfo(),
        loadDashboardTodaysClasses(),
        loadDashboardStudentPerformance(),
        loadSemesterStatus()
    ]);
    setupNavigation();
    setupPreferenceListeners();
    setupEnterKeySubmission();
    setupStudentFilters();
    setupConductFilter();
    setupSidebarToggle();
    setupMyClassScannerInput();

    // Fetch notifications on load, then poll every 60 seconds
    loadNotifications();
    setInterval(loadNotifications, 60000);

    // Semester status can change mid-session if Academic VP opens/closes
    // it while a teacher is logged in — poll every 2 minutes so the
    // header badge doesn't go stale for the rest of the day.
    setInterval(loadSemesterStatus, 120000);

    // Re-render "Now" / "Up next" on the Today's Classes widget every
    // minute so it stays accurate as time passes, without re-fetching the
    // timetable itself (that only needs to change if the schedule does).
    setInterval(() => { if (lastTodaysClasses) renderDashboardTodaysClasses(lastTodaysClasses); }, 60000);
});

let performanceChartInstance = null;
let lastPerformanceCompletion = null;

async function loadDashboardPerformance() {
    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/performance?teacher_id=${CURRENT_TEACHER_ID}`);
        if (!res.ok) throw new Error("Server error");
        const data = await res.json();
        renderPerformanceChart(data);
        lastPerformanceCompletion = data.completion;
        renderPerformanceCompletion(data.completion);
    } catch (err) {
        console.error("Performance load error:", err);
    }
}

function renderPerformanceChart(data) {
    const canvas = document.getElementById('performanceChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const labels = data.chart_data.map(d => d.subject_name);
    const s1Values = data.chart_data.map(d => d.semester_1 ?? 0);
    // If Semester 2 hasn't started yet, there's no real data to show —
    // render the bars as a flat, muted placeholder rather than zeros that
    // could be misread as "students scored 0".
    const s2Values = data.semester_2_started
        ? data.chart_data.map(d => d.semester_2 ?? 0)
        : labels.map(() => null);

    if (performanceChartInstance) {
        performanceChartInstance.destroy();
    }

    performanceChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Semester 1',
                    data: s1Values,
                    backgroundColor: '#1e3a8a'
                },
                {
                    label: data.semester_2_started ? 'Semester 2' : 'Semester 2 (not started)',
                    data: s2Values,
                    backgroundColor: data.semester_2_started ? '#60a5fa' : '#cbd5e1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, max: 100 }
            },
            plugins: {
                legend: { position: 'bottom' }
            }
        }
    });
}

function renderPerformanceCompletion(completion) {
    const el = document.getElementById('performance-completion');
    if (!el || !completion) return;

    const note = typeof t === 'function'
        ? t('perf_required_assessments').replace('{completed}', completion.completed).replace('{total}', completion.total)
        : `${completion.completed} of ${completion.total} required assessments at 50%+ entered`;

    el.innerHTML = `
        <div class="performance-completion-row">
            <span>${typeof t === 'function' ? t('perf_grading_completion') : 'Grading completion (this term)'}</span>
            <strong>${completion.percent}%</strong>
        </div>
        <div class="performance-completion-bar">
            <div class="performance-completion-fill" style="width:${completion.percent}%;"></div>
        </div>
        <p class="performance-completion-note">${note}</p>
    `;
}

// DASHBOARD: TEXTBOOK DISTRIBUTION WIDGET (homeroom teachers only)
// Reuses the same /api/homeroom/textbooks/push-status endpoint that
// powers the Textbooks page push widget — same underlying numbers, just
// a compact dashboard-friendly visual on top: a dot grid (one dot per
// book slot) plus the raw counts beneath it.
async function loadDashboardTextbookSummary() {
    const container = document.getElementById('dashboard-textbook-summary');
    if (!container) return;

    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/textbooks/push-status?teacher_id=${CURRENT_TEACHER_ID}`);
        const data = await res.json();

        if (!res.ok) {
            container.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${data.error || 'Could not load textbook data.'}</p>`;
            return;
        }

        lastDashboardTextbookData = data;
        renderDashboardTextbookSummary(data);
    } catch (err) {
        console.error("Dashboard textbook summary load error:", err);
        container.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not connect to server.</p>';
    }
}
let lastDashboardTextbookData = null;

// DASHBOARD: TODAY'S CLASSES WIDGET (all teachers)
// Reuses /api/teacher/my-timetable (the teacher's whole-week schedule)
// and filters down to today client-side, so the same endpoint can also
// back a future full-week view without a second call. day_of_week on the
// server is 1=Monday..5=Friday, deliberately matching JS Date#getDay()'s
// own weekday numbering — on a weekend getDay() returns 0 or 6, which
// naturally matches nothing and falls through to the "no classes" state.
let lastTodaysClasses = null;

async function loadDashboardTodaysClasses() {
    const container = document.getElementById('dashboard-todays-classes');
    if (!container) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/my-timetable`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load timetable");
        lastTodaysClasses = data;
        renderDashboardTodaysClasses(data);
    } catch (err) {
        console.error("Today's classes load error:", err);
        container.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${typeof t === 'function' ? t('dashboard_could_not_load_timetable') : "Could not load today's schedule."}</p>`;
    }
}

function formatTimeRange(startTime, endTime) {
    const fmt = (raw) => {
        const [h, m] = raw.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const hour12 = h % 12 === 0 ? 12 : h % 12;
        return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
    };
    return `${fmt(startTime)} – ${fmt(endTime)}`;
}

function renderDashboardTodaysClasses(rows) {
    const container = document.getElementById('dashboard-todays-classes');
    if (!container) return;

    const now = new Date();
    const todayDow = now.getDay();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const toMinutes = (t) => {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
    };

    const todays = (rows || [])
        .filter(r => r.day_of_week === todayDow)
        .sort((a, b) => a.start_time.localeCompare(b.start_time));

    if (todays.length === 0) {
        container.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${typeof t === 'function' ? t('dashboard_no_classes_today') : 'No classes scheduled today.'}</p>`;
        return;
    }

    // Which period is happening right now (start <= now <= end), and —
    // failing that — which one is next (soonest start still in the
    // future). Only one row ever gets tagged "now", and only one "next",
    // so a teacher glancing at the widget knows exactly where to be.
    let nowIndex = -1;
    let nextIndex = -1;
    todays.forEach((r, i) => {
        const start = toMinutes(r.start_time);
        const end = toMinutes(r.end_time);
        if (nowMinutes >= start && nowMinutes < end) {
            nowIndex = i;
        } else if (nowMinutes < start && nextIndex === -1) {
            nextIndex = i;
        }
    });

    const nowLabel = typeof t === 'function' ? t('dashboard_class_now') : 'Now';
    const nextLabel = typeof t === 'function' ? t('dashboard_class_next') : 'Up next';
    const doneLabel = typeof t === 'function' ? t('dashboard_class_done') : 'Done';

    container.innerHTML = `<div class="todays-classes-list">${todays.map((r, i) => {
        const end = toMinutes(r.end_time);
        let rowClass = '';
        let badge = '';
        if (i === nowIndex) {
            rowClass = 'is-now';
            badge = `<span class="todays-class-badge badge-now">${nowLabel}</span>`;
        } else if (i === nextIndex) {
            rowClass = 'is-next';
            badge = `<span class="todays-class-badge badge-next">${nextLabel}</span>`;
        } else if (nowMinutes >= end) {
            rowClass = 'is-done';
            badge = `<span class="todays-class-badge badge-done">${doneLabel}</span>`;
        }
        return `
        <div class="todays-class-row ${rowClass}">
            <div class="todays-class-time">${formatTimeRange(r.start_time, r.end_time)}</div>
            <div class="todays-class-info">
                <strong>${escapeHtml(r.subject_name)}</strong>
                <span>Grade ${escapeHtml(String(r.class_level))} - ${escapeHtml(r.section)} (${escapeHtml(r.stream)})</span>
            </div>
            ${badge}
        </div>`;
    }).join('')}</div>`;
}

// HEADER: SEMESTER STATUS BADGE (all teachers)
// Reuses /api/term/current, the same endpoint every portal already polls
// to know which term is active. semester_status is pushed by Academic VP
// via the Start Semester / Close Semester buttons on their own portal —
// this widget just reflects whatever that last press set: green "Open
// <term>" or red "Closed".
let lastSemesterStatus = null;

async function loadSemesterStatus() {
    const badge = document.getElementById('semester-status-badge');
    if (!badge) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/term/current`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load semester status");
        lastSemesterStatus = data;
        renderSemesterStatusBadge(data);
    } catch (err) {
        console.error("Semester status load error:", err);
        badge.style.display = 'inline-flex';
        badge.className = 'semester-status-badge semester-status-loading';
        badge.textContent = typeof t === 'function' ? t('semester_status_error') : 'Semester status unavailable';
    }
}

function renderSemesterStatusBadge(data) {
    const badge = document.getElementById('semester-status-badge');
    if (!badge || !data) return;

    badge.style.display = 'inline-flex';
    const isOpen = data.semester_status !== 'closed';
    badge.className = `semester-status-badge ${isOpen ? 'semester-status-open' : 'semester-status-closed'}`;

    if (isOpen) {
        const template = typeof t === 'function' ? t('semester_open') : 'Open {term}';
        badge.textContent = template.replace('{term}', data.current_term || '');
    } else {
        badge.textContent = typeof t === 'function' ? t('semester_closed') : 'Closed';
    }
}

// MY CLASS (homeroom teachers only) — today's attendance roster
let lastMyClassRoster = null;
let myClassSearchTerm = '';

async function loadMyClassRoster() {
    const container = document.getElementById('myclass-roster');
    if (!container) return;
    container.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${typeof t === 'function' ? t('loading_text') : 'Loading…'}</p>`;
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/attendance-today`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load roster");
        lastMyClassRoster = data;
        renderMyClassRoster(data);
    } catch (err) {
        console.error("My Class roster load error:", err);
        container.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${typeof t === 'function' ? t('myclass_could_not_load') : 'Could not load your class roster.'}</p>`;
    }
}

// Re-fetches the roster from the server but keeps the scroll list exactly
// where the teacher left it — used after a QR scan, where we don't
// necessarily know which row to patch locally.
async function refreshMyClassRosterPreservingScroll() {
    const scrollBox = document.getElementById('myclass-roster-scroll');
    const savedScrollTop = scrollBox ? scrollBox.scrollTop : 0;
    await loadMyClassRoster();
    if (scrollBox) scrollBox.scrollTop = savedScrollTop;
}

window.applyMyClassSearch = () => {
    const input = document.getElementById('myclass-search');
    myClassSearchTerm = input ? input.value.trim().toLowerCase() : '';
    if (lastMyClassRoster) renderMyClassRoster(lastMyClassRoster);
};

function renderMyClassRoster(data) {
    const container = document.getElementById('myclass-roster');
    if (!container || !data) return;

    const totalEl = document.getElementById('myclass-total-count');
    const presentEl = document.getElementById('myclass-present-count');
    const absentEl = document.getElementById('myclass-absent-count');
    if (totalEl) totalEl.textContent = data.total ?? 0;
    if (presentEl) presentEl.textContent = data.present_count ?? 0;
    if (absentEl) absentEl.textContent = (data.total ?? 0) - (data.present_count ?? 0);

    const roster = data.roster || [];

    const term = myClassSearchTerm;
    const visible = term
        ? roster.filter(s =>
            `${s.first_name} ${s.middle_name || ''} ${s.last_name}`.toLowerCase().includes(term) ||
            String(s.student_id).toLowerCase().includes(term))
        : roster;

    if (roster.length === 0) {
        container.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No students in your homeroom section yet.</p>';
        return;
    }
    if (visible.length === 0) {
        container.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No students match your search.</p>';
        return;
    }

    const presentLabel = typeof t === 'function' ? t('myclass_present_badge') : 'Present';
    const notMarkedLabel = typeof t === 'function' ? t('myclass_not_marked_badge') : 'Not marked yet';
    const markBtnLabel = typeof t === 'function' ? t('myclass_mark_present') : 'Mark Present';
    const undoBtnLabel = typeof t === 'function' ? t('myclass_undo') : 'Undo';

    container.innerHTML = `<div class="myclass-roster-list">${visible.map(s => `
        <div class="myclass-roster-row ${s.present ? 'is-present' : ''}" data-student-id="${escapeHtml(String(s.student_id))}">
            <span class="myclass-roster-name">${[s.first_name, s.middle_name, s.last_name].filter(Boolean).map(escapeHtml).join(' ')}</span>
            <span class="myclass-roster-status ${s.present ? 'status-present' : 'status-absent'}">${s.present ? presentLabel : notMarkedLabel}</span>
            ${s.present
                ? `<button class="textbook-action-btn textbook-action-undo" onclick="undoMyClassPresent('${s.student_id}')">${undoBtnLabel}</button>`
                : `<button class="textbook-action-btn" onclick="markMyClassPresent('${s.student_id}')">${markBtnLabel}</button>`
            }
        </div>`).join('')}</div>`;
}

// Marking/undoing updates the in-memory roster and re-renders in place —
// deliberately not a full loadMyClassRoster() round trip, so the list
// never resets scroll position or jumps back to the first student the
// way a full re-fetch/re-render would if this ran on every single click.
window.markMyClassPresent = async (student_id) => {
    const scrollBox = document.getElementById('myclass-roster-scroll');
    const savedScrollTop = scrollBox ? scrollBox.scrollTop : 0;
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/mark-present`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_id })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || "Could not mark attendance");

        if (lastMyClassRoster) {
            const entry = lastMyClassRoster.roster.find(s => String(s.student_id) === String(student_id));
            if (entry && !entry.present) {
                entry.present = true;
                entry.marked_by_me = true;
                lastMyClassRoster.present_count = (lastMyClassRoster.present_count || 0) + 1;
            }
            renderMyClassRoster(lastMyClassRoster);
        }
    } catch (err) {
        console.error("Mark present error:", err);
        showAlertModal(err.message || "Could not mark attendance.");
    } finally {
        if (scrollBox) scrollBox.scrollTop = savedScrollTop;
    }
};

window.undoMyClassPresent = async (student_id) => {
    const scrollBox = document.getElementById('myclass-roster-scroll');
    const savedScrollTop = scrollBox ? scrollBox.scrollTop : 0;
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/undo-present`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_id })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || "Could not undo attendance mark");

        if (lastMyClassRoster) {
            const entry = lastMyClassRoster.roster.find(s => String(s.student_id) === String(student_id));
            if (entry && entry.present) {
                entry.present = false;
                entry.marked_by_me = false;
                lastMyClassRoster.present_count = Math.max(0, (lastMyClassRoster.present_count || 0) - 1);
            }
            renderMyClassRoster(lastMyClassRoster);
        }
    } catch (err) {
        console.error("Undo present error:", err);
        showAlertModal(err.message || "Could not undo attendance mark.");
    } finally {
        if (scrollBox) scrollBox.scrollTop = savedScrollTop;
    }
};

// --- QR / handheld-scanner check-in (My Class page) ---
// Two ways in: (1) a camera-based scanner (html5-qrcode, loaded via CDN in
// index.html) for phones/webcams, and (2) a plain text input for
// keyboard-wedge handheld scanners (like the Honeywell mentioned on the
// server) — those just "type" the QR payload followed by Enter into
// whatever's focused, so a normal input field is all that's needed.
// Both funnel into the same POST /api/attendance/checkin used elsewhere.
let qrScannerInstance = null;

async function submitQrCheckin(qr_data) {
    const status = document.getElementById('qr-scan-status');
    try {
        const res = await apiFetch(`${API_BASE}/api/attendance/checkin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_data })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || "Check-in failed");

        if (status) {
            status.style.color = '#166534';
            status.textContent = result.message;
        }
        await refreshMyClassRosterPreservingScroll();
        return true;
    } catch (err) {
        console.error("QR check-in error:", err);
        if (status) {
            status.style.color = '#991b1b';
            status.textContent = err.message || "Check-in failed.";
        }
        return false;
    }
}

window.openQrScanner = () => {
    const modal = document.getElementById('qr-scan-modal');
    const status = document.getElementById('qr-scan-status');
    if (!modal) return;
    modal.style.display = 'flex';
    if (status) { status.textContent = ''; status.style.color = ''; }

    if (typeof Html5Qrcode === 'undefined') {
        if (status) {
            status.style.color = '#991b1b';
            status.textContent = "Camera scanner unavailable — use the handheld scanner input on the page instead.";
        }
        return;
    }

    qrScannerInstance = new Html5Qrcode('qr-reader');
    qrScannerInstance.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: 220 },
        async (decodedText) => {
            // Pause further scans while this one is being submitted, so
            // the same card held in frame doesn't fire the endpoint
            // repeatedly.
            if (qrScannerInstance) {
                try { await qrScannerInstance.pause(true); } catch (e) { /* already stopped */ }
            }
            await submitQrCheckin(decodedText);
            if (qrScannerInstance) {
                try { qrScannerInstance.resume(); } catch (e) { /* modal likely closed */ }
            }
        },
        () => { /* per-frame "no QR found" noise — ignored on purpose */ }
    ).catch(err => {
        console.error("Camera start error:", err);
        if (status) {
            status.style.color = '#991b1b';
            status.textContent = "Could not access the camera. Check permissions, or use the handheld scanner input instead.";
        }
    });
};

window.closeQrScanner = () => {
    const modal = document.getElementById('qr-scan-modal');
    if (modal) modal.style.display = 'none';
    if (qrScannerInstance) {
        qrScannerInstance.stop().then(() => qrScannerInstance.clear()).catch(() => {});
        qrScannerInstance = null;
    }
};

function setupMyClassScannerInput() {
    const input = document.getElementById('myclass-scanner-input');
    if (!input) return;
    input.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const value = input.value.trim();
        input.value = '';
        if (!value) return;
        await submitQrCheckin(value);
        input.focus();
    });
}

// DASHBOARD: STUDENT PERFORMANCE WIDGET (all teachers)
// Every student this teacher is assigned to, with their average score
// this term in the teacher's own subject(s) and a color-coded tier — see
// /api/teacher/student-performance on the server for how the tier
// thresholds are computed. Sorted so students who need attention surface
// first rather than being buried alphabetically among students already
// doing fine.
let lastStudentPerformance = null;
const PERF_TIER_ORDER = { poor: 0, average: 1, none: 2, good: 3 };
const PERF_TIER_FALLBACK_LABELS = { good: 'Good', average: 'Average', poor: 'Needs Attention', none: 'No marks yet' };

async function loadDashboardStudentPerformance() {
    const container = document.getElementById('dashboard-student-performance');
    if (!container) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/student-performance`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load student performance");
        lastStudentPerformance = data;
        renderDashboardStudentPerformance(data);
    } catch (err) {
        console.error("Student performance load error:", err);
        container.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${typeof t === 'function' ? t('perf_could_not_load') : 'Could not load student performance.'}</p>`;
    }
}

function renderDashboardStudentPerformance(data) {
    const container = document.getElementById('dashboard-student-performance');
    if (!container) return;
    const students = (data && data.students) || [];

    if (students.length === 0) {
        container.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${typeof t === 'function' ? t('perf_no_students') : 'No students assigned yet.'}</p>`;
        return;
    }

    const sorted = [...students].sort((a, b) => PERF_TIER_ORDER[a.tier] - PERF_TIER_ORDER[b.tier]);
    const tierLabel = (tier) => typeof t === 'function' ? t(`perf_tier_${tier}`) : PERF_TIER_FALLBACK_LABELS[tier];

    container.innerHTML = `<div class="perf-list">${sorted.map(s => `
        <div class="perf-row">
            <span class="perf-dot perf-dot-${s.tier}" aria-hidden="true"></span>
            <span class="perf-name">${escapeHtml(s.full_name)}</span>
            <span class="perf-score">${s.average_score != null ? s.average_score + '%' : '—'}</span>
            <span class="perf-tier-badge perf-tier-badge-${s.tier}">${tierLabel(s.tier)}</span>
        </div>`).join('')}</div>`;
}

function renderDashboardTextbookSummary(data) {
    const container = document.getElementById('dashboard-textbook-summary');
    if (!container) return;

    if (data.total_slots === 0) {
        container.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${typeof t === 'function' ? t('textbook_no_setup') : 'No students or subjects set up yet for your section.'}</p>`;
        return;
    }

    // Build one dot per book slot: outstanding (issued, not yet resolved)
    // shows amber, returned shows gray, lost shows red — matching the
    // status colors used on the Textbooks page, except returned is
    // intentionally gray here so a glance at the dashboard reads as
    // "color = still needs attention, gray = handled".
    //
    // Capped at MAX_DOTS so a large section (many students x many
    // subjects) doesn't render hundreds of tiny dots and turn into visual
    // noise on a compact dashboard card — proportionally samples from
    // each status bucket so the cap doesn't accidentally hide one status
    // entirely (e.g. always showing all amber dots and zero lost ones).
    const MAX_DOTS = 120;
    const dots = [];
    const buildBucket = (count, status) => { for (let i = 0; i < count; i++) dots.push(status); };

    if (data.total_slots <= MAX_DOTS) {
        buildBucket(data.lost_count, 'lost');
        buildBucket(data.returned_count, 'returned');
        buildBucket(data.outstanding_count, 'outstanding');
    } else {
        const scale = MAX_DOTS / data.total_slots;
        // Lost gets priority (rounded up) so a small number of lost books
        // never silently rounds down to zero dots and disappears visually.
        const lostDots = Math.min(MAX_DOTS, Math.ceil(data.lost_count * scale));
        const returnedDots = Math.min(MAX_DOTS - lostDots, Math.round(data.returned_count * scale));
        const outstandingDots = Math.max(0, MAX_DOTS - lostDots - returnedDots);
        buildBucket(lostDots, 'lost');
        buildBucket(returnedDots, 'returned');
        buildBucket(outstandingDots, 'outstanding');
    }

    const dotHtml = dots.map(status => `<span class="textbook-dot textbook-dot-${status}"></span>`).join('');
    const cappedNote = data.total_slots > MAX_DOTS
        ? `<p style="font-size:0.75rem; color:#64748b; margin-top:4px;">${(typeof t === 'function' ? t('textbook_sample_note') : 'Showing a proportional sample — {total} total slots.').replace('{total}', data.total_slots)}</p>`
        : '';

    const resolvedNote = typeof t === 'function'
        ? t('textbook_slots_resolved')
            .replace('{resolved}', data.returned_count + data.lost_count)
            .replace('{total}', data.total_slots)
            .replace('{percent}', data.percent_resolved)
            .replace('{out}', data.outstanding_count)
            .replace('{lost}', data.lost_count)
        : `${data.returned_count + data.lost_count} of ${data.total_slots} book slots resolved (${data.percent_resolved}%) — ${data.outstanding_count} still out, ${data.lost_count} lost.`;

    container.innerHTML = `
        <div class="textbook-dot-grid" title="${data.outstanding_count} still out, ${data.returned_count} returned, ${data.lost_count} lost">
            ${dotHtml}
        </div>
        ${cappedNote}
        <div class="textbook-dot-legend">
            <span><span class="textbook-dot textbook-dot-outstanding"></span> ${typeof t === 'function' ? t('textbook_issued_out') : 'Issued (out)'}</span>
            <span><span class="textbook-dot textbook-dot-returned"></span> ${typeof t === 'function' ? t('textbook_returned') : 'Returned'}</span>
            <span><span class="textbook-dot textbook-dot-lost"></span> ${typeof t === 'function' ? t('textbook_lost') : 'Lost'}</span>
        </div>
        <p class="performance-completion-note" style="margin-top:10px;">
            ${resolvedNote}
        </p>
    `;
}

// ASSESSMENT & EXAM CONDUCT WIDGET
// Stores the last-loaded conduct data so the section filter can
// re-render without re-fetching.
let conductData = [];

async function loadConductStatus() {
    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/conduct-status?teacher_id=${CURRENT_TEACHER_ID}`);
        if (!res.ok) throw new Error("Could not load conduct status");
        conductData = await res.json();

        populateConductSectionFilter(conductData);
        renderConductList(conductData);
    } catch (err) {
        console.error("Conduct status load error:", err);
        const list = document.getElementById('conduct-list');
        if (list) list.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not load conduct status.</p>';
    }
}

// Builds the "All my sections" + one option per distinct section this
// teacher is assigned to.
function populateConductSectionFilter(data) {
    const select = document.getElementById('conduct-section-filter');
    if (!select) return;

    const seen = new Set();
    const allLabel = typeof t === 'function' ? t('widget_all_my_sections') : 'All my sections';
    const options = [`<option value="">${allLabel}</option>`];

    data.forEach(entry => {
        const key = `${entry.class_level}|${entry.section}|${entry.stream}`;
        if (seen.has(key)) return;
        seen.add(key);
        const label = formatGradeSectionStream(entry.class_level, entry.section, entry.stream);
        options.push(`<option value="${key}">${label}</option>`);
    });

    select.innerHTML = options.join('');
}

// Shared "Grade {level} - {section} ({stream})" label, used across the
// conduct widget, push-status list, and the section filter dropdown.
function formatGradeSectionStream(level, section, stream) {
    if (typeof t === 'function') {
        return t('grade_section_stream')
            .replace('{level}', level)
            .replace('{section}', section)
            .replace('{stream}', stream);
    }
    return `Grade ${level} - ${section} (${stream})`;
}

function setupConductFilter() {
    const select = document.getElementById('conduct-section-filter');
    if (!select) return;
    select.addEventListener('change', () => {
        const filterKey = select.value;
        if (!filterKey) {
            renderConductList(conductData);
            return;
        }
        const filtered = conductData.filter(entry =>
            `${entry.class_level}|${entry.section}|${entry.stream}` === filterKey
        );
        renderConductList(filtered);
    });
}

const ASSESSMENT_TYPE_I18N_KEYS = {
    individual_assignment_1: 'assessment_individual_assignment_1',
    individual_assignment_2: 'assessment_individual_assignment_2',
    group_assignment: 'assessment_group_assignment',
    quiz: 'assessment_quiz',
    midterm: 'assessment_midterm',
    final: 'assessment_final'
};
const ASSESSMENT_TYPE_LABELS_FALLBACK = {
    individual_assignment_1: 'Ind. Assignment 1',
    individual_assignment_2: 'Ind. Assignment 2',
    group_assignment: 'Group Assignment',
    quiz: 'Quiz',
    midterm: 'Midterm',
    final: 'Final'
};
function assessmentTypeLabel(type) {
    const key = ASSESSMENT_TYPE_I18N_KEYS[type];
    if (key && typeof t === 'function') return t(key);
    return ASSESSMENT_TYPE_LABELS_FALLBACK[type] || type;
}

// Renders one card per (subject, section) assignment, each with 6
// read-only ticks. Ticks are entirely derived from the API response —
// there is no click handler, since this is auto-calculated, not manual.
function renderConductList(data) {
    const list = document.getElementById('conduct-list');
    if (!list) return;

    if (!Array.isArray(data) || data.length === 0) {
        list.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No section assignments found.</p>';
        return;
    }

    const renderTicks = (checklist) => checklist.map(item => {
        const tickClass = item.conducted ? 'conduct-tick conduct-tick-done' : 'conduct-tick';
        const symbol = item.conducted ? '&#10003;' : '';
        const label = assessmentTypeLabel(item.type);
        return `
            <div class="conduct-item" title="${item.marked}/${item.total} students (${item.percent}%)">
                <span class="${tickClass}">${symbol}</span>
                <span class="conduct-item-label">${label}</span>
            </div>`;
    }).join('');

    list.innerHTML = data.map(entry => {
        const terms = Object.keys(entry.checklistByTerm || {});
        const termRows = terms.map(term => `
            <div class="conduct-term-row">
                <span class="conduct-term-label">${term}</span>
                <div class="conduct-checklist">${renderTicks(entry.checklistByTerm[term])}</div>
            </div>`).join('');

        return `
            <div class="conduct-card">
                <div class="conduct-card-header">
                    <strong>${entry.subject_name}</strong>
                    <span class="conduct-card-section">${formatGradeSectionStream(entry.class_level, entry.section, entry.stream)}</span>
                </div>
                ${termRows}
            </div>`;
    }).join('');
}

// PUSH TO HOMEROOM (Reports page)
async function loadPushStatus() {
    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/push-status?teacher_id=${CURRENT_TEACHER_ID}`);
        if (!res.ok) throw new Error("Could not load push status");
        const data = await res.json();
        renderPushList(data);
    } catch (err) {
        console.error("Push status load error:", err);
        const list = document.getElementById('push-list');
        if (list) list.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not load push status.</p>';
    }
}

function renderPushList(data) {
    const list = document.getElementById('push-list');
    if (!list) return;

    if (!Array.isArray(data) || data.length === 0) {
        list.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No section assignments found.</p>';
        return;
    }

    list.innerHTML = data.map(entry => {
        const statusHtml = entry.pushed
            ? `<span class="push-status push-status-locked">&#128274; Pushed &amp; locked (${new Date(entry.pushed_at).toLocaleDateString()})</span>`
            : `<button class="btn-primary push-btn" onclick='pushReport(${JSON.stringify({
                subject_id: entry.subject_id,
                class_level: entry.class_level,
                section: entry.section,
                stream: entry.stream
              })})'>Push ${entry.term} Report</button>`;

        return `
            <div class="conduct-card">
                <div class="conduct-card-header">
                    <strong>${entry.subject_name}</strong>
                    <span class="conduct-card-section">${formatGradeSectionStream(entry.class_level, entry.section, entry.stream)} — ${entry.term}</span>
                </div>
                <div style="margin-top:8px;">${statusHtml}</div>
            </div>`;
    }).join('');
}

window.pushReport = async (assignment) => {
    const confirmed = await showConfirmModal(
        "This will LOCK it — you won't be able to enter any more marks for this subject/section/term afterward.",
        "Push this report to the homeroom teacher?"
    );
    if (!confirmed) return;

    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/push-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID, ...assignment })
        });
        const result = await res.json();

        if (!res.ok) {
            showAlertModal(result.error || "Could not push report.");
            return;
        }

        showSuccessModal(result.message);
        await loadPushStatus();
    } catch (err) {
        console.error("Push report error:", err);
        showAlertModal("Could not connect to server.");
    }
};

// HOMEROOM REPORTS (Reports page)
let homeroomInfo = null;

async function loadHomeroomInfo() {
    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/homeroom-info?teacher_id=${CURRENT_TEACHER_ID}`);
        if (!res.ok) throw new Error("Could not load homeroom info");
        homeroomInfo = await res.json();

        const widget = document.getElementById('homeroom-widget');
        if (widget) widget.style.display = homeroomInfo.is_homeroom ? 'block' : 'none';

        const textbooksNav = document.getElementById('nav-textbooks');
        if (textbooksNav) textbooksNav.style.display = homeroomInfo.is_homeroom ? 'block' : 'none';

        const myClassNav = document.getElementById('nav-myclass');
        if (myClassNav) myClassNav.style.display = homeroomInfo.is_homeroom ? 'block' : 'none';

        const actionCenterNav = document.getElementById('nav-actioncenter');
        if (actionCenterNav) actionCenterNav.style.display = homeroomInfo.is_homeroom ? 'block' : 'none';

        const dashboardTextbookWidget = document.getElementById('dashboard-textbook-widget');
        if (dashboardTextbookWidget) dashboardTextbookWidget.style.display = homeroomInfo.is_homeroom ? 'block' : 'none';

        if (homeroomInfo.is_homeroom) {
            const label = document.getElementById('homeroom-section-label');
            if (label) label.textContent = `Grade ${homeroomInfo.class_level} - ${homeroomInfo.section} (${homeroomInfo.stream})`;

            const dashboardLabel = document.getElementById('dashboard-textbook-section-label');
            if (dashboardLabel) dashboardLabel.textContent = `Grade ${homeroomInfo.class_level} - ${homeroomInfo.section} (${homeroomInfo.stream})`;

            const myClassLabel = document.getElementById('myclass-section-label');
            if (myClassLabel) myClassLabel.textContent = `Grade ${homeroomInfo.class_level} - ${homeroomInfo.section} (${homeroomInfo.stream})`;

            const sidebarBadge = document.getElementById('sidebar-homeroom-badge');
            const sidebarLabel = document.getElementById('sidebar-homeroom-label');
            if (sidebarLabel) sidebarLabel.textContent = `Grade ${homeroomInfo.class_level} - ${homeroomInfo.section}`;
            if (sidebarBadge) sidebarBadge.style.display = 'flex';

            await Promise.all([
                loadDashboardTextbookSummary(),
                loadMarksPushStatus(),
                loadActionCenterRequests()
            ]);
        } else {
            const sidebarBadge = document.getElementById('sidebar-homeroom-badge');
            if (sidebarBadge) sidebarBadge.style.display = 'none';
        }
    } catch (err) {
        console.error("Homeroom info load error:", err);
    }
}

window.loadHomeroomStudentReport = async () => {
    const studentId = document.getElementById('homeroom-student-id').value.trim();
    const output = document.getElementById('homeroom-report-output');
    if (!studentId) return showAlertModal("Please enter a Student ID");

    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/student-report/${studentId}`);
        if (!res.ok) throw new Error("Could not load student report");
        const report = await res.json();

        if (!Array.isArray(report) || report.length === 0) {
            output.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No pushed reports found for this student yet.</p>';
            return;
        }

        const rows = report.map(r => `
            <tr>
                <td>${r.subject_name}</td>
                <td>${r.semester_1 != null ? r.semester_1 : '<span class="shaded-blank">N/A</span>'}</td>
                <td>${r.semester_2 != null ? r.semester_2 : '<span class="shaded-blank">N/A</span>'}</td>
                <td>${r.year_average != null ? r.year_average : '<span class="shaded-blank">N/A</span>'}</td>
            </tr>`).join('');

        output.innerHTML = `
            <table id="progress-table">
                <thead><tr><th>Subject</th><th>Semester 1</th><th>Semester 2</th><th>Year Average</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
    } catch (err) {
        console.error("Student report load error:", err);
        output.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not load report.</p>';
    }
};

let lastSectionReport = null;

window.loadHomeroomSectionReport = async () => {
    if (!homeroomInfo || !homeroomInfo.is_homeroom) return;
    const output = document.getElementById('homeroom-report-output');

    try {
        const url = `${API_BASE}/api/homeroom/section-report?class_level=${homeroomInfo.class_level}&section=${homeroomInfo.section}&stream=${encodeURIComponent(homeroomInfo.stream)}`;
        const res = await apiFetch(url);
        if (!res.ok) throw new Error("Could not load section report");
        const data = await res.json();
        lastSectionReport = data;

        if (!data.students || data.students.length === 0) {
            output.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No students found for this section.</p>';
            return;
        }
        if (data.subject_columns.length === 0) {
            output.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No subjects have been pushed for this section yet.</p>';
            return;
        }

        const headerCells = data.subject_columns.map(name => `<th colspan="3">${name}</th>`).join('');
        const subHeaderCells = data.subject_columns.map(() => '<th>S1</th><th>S2</th><th>Avg</th>').join('');

        const rows = data.students.map(student => {
            const cells = data.subject_columns.map(name => {
                const subj = student.subjects[name] || {};
                const cell = (v) => v != null ? v : '<span class="shaded-blank">N/A</span>';
                return `<td>${cell(subj.semester_1)}</td><td>${cell(subj.semester_2)}</td><td>${cell(subj.year_average)}</td>`;
            }).join('');
            return `<tr><td>${student.student_id}</td><td>${student.full_name}</td>${cells}</tr>`;
        }).join('');

        output.innerHTML = `
            <button class="btn-primary" onclick="exportSectionReportCSV()" style="margin-bottom:12px; width:auto; padding:8px 16px;">Export CSV</button>
            <div style="overflow-x:auto;">
                <table id="progress-table">
                    <thead>
                        <tr><th rowspan="2">ID</th><th rowspan="2">Full Name</th>${headerCells}</tr>
                        <tr>${subHeaderCells}</tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    } catch (err) {
        console.error("Section report load error:", err);
        output.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not load section report.</p>';
    }
};

window.exportSectionReportCSV = () => {
    if (!lastSectionReport) return;
    const { subject_columns, students } = lastSectionReport;

    const header = ['Student ID', 'Full Name'];
    subject_columns.forEach(name => header.push(`${name} S1`, `${name} S2`, `${name} Avg`));

    const lines = [header.join(',')];
    students.forEach(student => {
        const row = [student.student_id, `"${student.full_name}"`];
        subject_columns.forEach(name => {
            const subj = student.subjects[name] || {};
            row.push(subj.semester_1 ?? '', subj.semester_2 ?? '', subj.year_average ?? '');
        });
        lines.push(row.join(','));
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `section_report_${homeroomInfo.section}.csv`;
    a.click();
    URL.revokeObjectURL(url);
};

// HOMEROOM: reset a forgotten student password back to the school
// default (1234). Server re-verifies the student is actually in this
// teacher's homeroom section before touching anything.
window.resetHomeroomStudentPassword = async () => {
    const input = document.getElementById('homeroom-reset-student-id');
    const status = document.getElementById('homeroom-reset-status');
    const studentId = input ? input.value.trim() : '';

    if (!studentId) {
        showAlertModal(typeof t === 'function' ? t('homeroom_reset_enter_id') : "Please enter a student ID.");
        return;
    }

    const confirmMsg = typeof t === 'function' ? t('homeroom_reset_confirm') : "Reset this student's password to the default (1234)? They should change it after logging back in.";
    const confirmTitle = typeof t === 'function' ? t('homeroom_reset_confirm_title') : "Reset password?";
    const confirmed = await showConfirmModal(confirmMsg, confirmTitle);
    if (!confirmed) return;

    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/reset-student-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_id: studentId })
        });
        const data = await res.json();

        if (res.ok) {
            if (status) status.innerHTML = `<span style="color:#166534;">${typeof t === 'function' ? t('homeroom_reset_success') : 'Password reset. The student can now log in with the default password 1234 and should change it from their Profile page.'}</span>`;
            if (input) input.value = '';
        } else {
            if (status) status.innerHTML = `<span style="color:#b91c1c;">${data.error || (typeof t === 'function' ? t('homeroom_reset_failed') : 'Could not reset this student\'s password.')}</span>`;
        }
    } catch (err) {
        console.error("Reset student password error:", err);
        if (status) status.innerHTML = `<span style="color:#b91c1c;">Could not connect to server.</span>`;
    }
};

// ACTION CENTER (homeroom teachers only): photo/certificate approvals,
// direct photo upload, badge count. Requests are fetched lazily when the
// tab is opened (see setupNavigation's `target === 'actioncenter'` hook)
// and again after any approve/reject so the list and badge stay in sync.
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function updateActionCenterBadge(count) {
    const badge = document.getElementById('action-center-badge');
    if (!badge) return;
    if (count > 0) {
        badge.textContent = String(count);
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

function renderPhotoRequests(requests) {
    const list = document.getElementById('photo-requests-list');
    if (!list) return;

    if (!Array.isArray(requests) || requests.length === 0) {
        list.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No pending photo requests.</p>';
        return;
    }

    list.innerHTML = requests.map(r => `
        <div class="request-card">
            <div class="request-photo-thumbs">
                <figure>
                    ${r.current_photo_url
                        ? `<img class="request-photo-thumb" src="${escapeHtml(r.current_photo_url)}" alt="Current photo">`
                        : `<div class="request-photo-thumb"></div>`}
                    <figcaption>Current</figcaption>
                </figure>
                <figure>
                    <img class="request-photo-thumb" src="${escapeHtml(r.requested_photo_url)}" alt="Requested photo">
                    <figcaption>Requested</figcaption>
                </figure>
            </div>
            <div class="request-info">
                <strong>${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)}</strong>
                <span>${escapeHtml(r.student_id)} — requested ${new Date(r.requested_at).toLocaleDateString()}</span>
            </div>
            <div class="request-actions">
                <button type="button" class="request-approve-btn" onclick="approvePhotoRequest(${r.request_id})">Approve</button>
                <button type="button" class="request-reject-btn" onclick="rejectPhotoRequest(${r.request_id})">Reject</button>
            </div>
        </div>`).join('');
}

function renderCertificateRequests(requests) {
    const list = document.getElementById('certificate-requests-list');
    if (!list) return;

    if (!Array.isArray(requests) || requests.length === 0) {
        list.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No pending certificate requests.</p>';
        return;
    }

    list.innerHTML = requests.map(r => `
        <div class="request-card">
            <div class="request-info">
                <strong>${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)}</strong>
                <span>${escapeHtml(r.student_id)} — requested ${new Date(r.requested_at).toLocaleDateString()}</span>
            </div>
            <div class="request-actions">
                <button type="button" class="request-approve-btn" onclick="approveCertificateRequest(${r.request_id})">Approve</button>
                <button type="button" class="request-reject-btn" onclick="rejectCertificateRequest(${r.request_id})">Reject</button>
            </div>
        </div>`).join('');
}

// Loads all three request lists in parallel, renders them, and refreshes
// the sidebar badge from their combined pending count.
async function loadActionCenterRequests() {
    const photoList = document.getElementById('photo-requests-list');
    const certList = document.getElementById('certificate-requests-list');
    const absenceList = document.getElementById('absence-requests-list');
    if (photoList) photoList.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Loading…</p>';
    if (certList) certList.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Loading…</p>';
    if (absenceList) absenceList.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Loading…</p>';

    try {
        const [photoRes, certRes, absenceRes] = await Promise.all([
            apiFetch(`${API_BASE}/api/homeroom/id-photo-requests`),
            apiFetch(`${API_BASE}/api/homeroom/certificate-requests`),
            apiFetch(`${API_BASE}/api/homeroom/absence-requests`)
        ]);
        const photoRequests = photoRes.ok ? await photoRes.json() : [];
        const certRequests = certRes.ok ? await certRes.json() : [];
        const absenceRequests = absenceRes.ok ? await absenceRes.json() : [];

        renderPhotoRequests(photoRequests);
        renderCertificateRequests(certRequests);
        renderAbsenceRequests(absenceRequests);
        updateActionCenterBadge(photoRequests.length + certRequests.length + absenceRequests.length);
    } catch (err) {
        console.error("loadActionCenterRequests error:", err);
        if (photoList) photoList.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not load requests.</p>';
        if (certList) certList.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not load requests.</p>';
        if (absenceList) absenceList.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not load requests.</p>';
    }
}

// Absence requests carry two extra pieces the photo/certificate cards
// don't: a date range + day count, and a within_homeroom_authority flag
// (computed server-side) that decides whether this teacher can Approve
// directly or must Escalate instead — the server enforces the same cap
// on the actual approve call, so this only ever affects which buttons
// are shown, never what's actually allowed.
function renderAbsenceRequests(requests) {
    const list = document.getElementById('absence-requests-list');
    if (!list) return;

    if (!Array.isArray(requests) || requests.length === 0) {
        list.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${typeof t === 'function' ? t('absence_no_requests') : 'No pending absence requests.'}</p>`;
        return;
    }

    list.innerHTML = requests.map(r => {
        const from = new Date(r.date_from).toLocaleDateString();
        const to = new Date(r.date_to).toLocaleDateString();
        const attachment = r.attachment_url
            ? `<a href="${escapeHtml(r.attachment_url)}" target="_blank" rel="noopener" style="font-size:0.78rem;">${typeof t === 'function' ? t('absence_view_attachment') : 'View attachment'}</a>`
            : '';
        const authorityNote = r.within_homeroom_authority
            ? ''
            : `<span class="absence-span-warning">${(typeof t === 'function' ? t('absence_beyond_authority_note') : 'Covers {days} days — beyond what you can approve directly.').replace('{days}', r.span_days)}</span>`;
        const actionButtons = r.within_homeroom_authority
            ? `<button type="button" class="request-approve-btn" onclick="approveAbsenceRequest(${r.request_id})">${typeof t === 'function' ? t('absence_approve') : 'Approve'}</button>
               <button type="button" class="request-reject-btn" onclick="rejectAbsenceRequest(${r.request_id})">${typeof t === 'function' ? t('absence_reject') : 'Reject'}</button>`
            : `<button type="button" class="request-escalate-btn" onclick="escalateAbsenceRequest(${r.request_id})">${typeof t === 'function' ? t('absence_escalate') : 'Escalate to Admin'}</button>
               <button type="button" class="request-reject-btn" onclick="rejectAbsenceRequest(${r.request_id})">${typeof t === 'function' ? t('absence_reject') : 'Reject'}</button>`;

        return `
        <div class="request-card">
            <div class="request-info">
                <strong>${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)}</strong>
                <span>${escapeHtml(r.student_id)} — ${from} – ${to} (${r.span_days} day${r.span_days === 1 ? '' : 's'})</span>
                ${r.reason ? `<span style="display:block; margin-top:4px;">${escapeHtml(r.reason)}</span>` : ''}
                ${attachment ? `<span style="display:block; margin-top:4px;">${attachment}</span>` : ''}
                ${authorityNote}
            </div>
            <div class="request-actions">
                ${actionButtons}
            </div>
        </div>`;
    }).join('');
}

window.approveAbsenceRequest = async (requestId) => {
    const confirmed = await showConfirmModal("Approve this absence request? These days won't count as unexcused absences.", "Approve absence?");
    if (!confirmed) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/absence-requests/${requestId}/approve`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showAlertModal(data.error || "Could not approve this request."); return; }
        showSuccessModal(data.message);
        await loadActionCenterRequests();
    } catch (err) {
        console.error("approveAbsenceRequest error:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.rejectAbsenceRequest = async (requestId) => {
    const reason = await showPromptModal(
        "Reject this absence request? You can add an optional reason below — it'll be shown to the student.",
        "Reject request?",
        "Reason (optional)"
    );
    if (reason === null) return; // cancelled
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/absence-requests/${requestId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason || undefined })
        });
        const data = await res.json();
        if (!res.ok) { showAlertModal(data.error || "Could not reject this request."); return; }
        showSuccessModal(data.message);
        await loadActionCenterRequests();
    } catch (err) {
        console.error("rejectAbsenceRequest error:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.escalateAbsenceRequest = async (requestId) => {
    const note = await showPromptModal(
        "Escalate this to school administration for review? You can add an optional note below explaining why.",
        "Escalate to Admin?",
        "Note (optional)"
    );
    if (note === null) return; // cancelled
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/absence-requests/${requestId}/escalate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: note || undefined })
        });
        const data = await res.json();
        if (!res.ok) { showAlertModal(data.error || "Could not escalate this request."); return; }
        showSuccessModal(data.message);
        await loadActionCenterRequests();
    } catch (err) {
        console.error("escalateAbsenceRequest error:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.approvePhotoRequest = async (requestId) => {
    const confirmed = await showConfirmModal("Approve this photo? It will become the student's official ID photo.", "Approve photo?");
    if (!confirmed) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/id-photo-requests/${requestId}/approve`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showAlertModal(data.error || "Could not approve this request."); return; }
        showSuccessModal(data.message);
        await loadActionCenterRequests();
    } catch (err) {
        console.error("approvePhotoRequest error:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.rejectPhotoRequest = async (requestId) => {
    const reason = await showPromptModal(
        "Reject this photo request? You can add an optional reason below — it'll be shown to the student.",
        "Reject photo?",
        "Reason (optional)"
    );
    if (reason === null) return; // cancelled
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/id-photo-requests/${requestId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason || undefined })
        });
        const data = await res.json();
        if (!res.ok) { showAlertModal(data.error || "Could not reject this request."); return; }
        showSuccessModal(data.message);
        await loadActionCenterRequests();
    } catch (err) {
        console.error("rejectPhotoRequest error:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.approveCertificateRequest = async (requestId) => {
    const confirmed = await showConfirmModal("Approve this certificate request? The student will be able to download their certificate.", "Approve certificate?");
    if (!confirmed) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/certificate-requests/${requestId}/approve`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showAlertModal(data.error || "Could not approve this request."); return; }
        showSuccessModal(data.message);
        await loadActionCenterRequests();
    } catch (err) {
        console.error("approveCertificateRequest error:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.rejectCertificateRequest = async (requestId) => {
    const reason = await showPromptModal(
        "Reject this certificate request? You can add an optional reason below — it'll be shown to the student.",
        "Reject certificate?",
        "Reason (optional)"
    );
    if (reason === null) return; // cancelled
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/certificate-requests/${requestId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason || undefined })
        });
        const data = await res.json();
        if (!res.ok) { showAlertModal(data.error || "Could not reject this request."); return; }
        showSuccessModal(data.message);
        await loadActionCenterRequests();
    } catch (err) {
        console.error("rejectCertificateRequest error:", err);
        showAlertModal("Could not connect to server.");
    }
};

// Direct photo upload — no approval step needed, becomes official
// immediately (see /api/homeroom/upload-student-photo on the server).
window.uploadStudentPhoto = async () => {
    const idInput = document.getElementById('upload-photo-student-id');
    const fileInput = document.getElementById('upload-photo-file');
    const status = document.getElementById('upload-photo-status');

    const studentId = idInput ? idInput.value.trim() : '';
    const file = fileInput && fileInput.files ? fileInput.files[0] : null;

    if (!studentId) { showAlertModal("Please enter a Student ID"); return; }
    if (!file) { showAlertModal("Please choose a photo to upload"); return; }

    const formData = new FormData();
    formData.append('student_id', studentId);
    formData.append('photo', file);

    if (status) status.innerHTML = '<span style="color:#64748b;">Uploading…</span>';

    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/upload-student-photo`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();

        if (!res.ok) {
            if (status) status.innerHTML = `<span style="color:#b91c1c;">${escapeHtml(data.error || "Could not upload this photo.")}</span>`;
            return;
        }

        if (status) status.innerHTML = `<span style="color:#166534;">${escapeHtml(data.message)}</span>`;
        if (idInput) idInput.value = '';
        if (fileInput) fileInput.value = '';
        // A pending self-submitted request from this student, if any, is
        // auto-resolved server-side — refresh so it drops off the list.
        await loadActionCenterRequests();
    } catch (err) {
        console.error("uploadStudentPhoto error:", err);
        if (status) status.innerHTML = '<span style="color:#b91c1c;">Could not connect to server.</span>';
    }
};

// TEXTBOOK DISTRIBUTION (homeroom teachers only)
let textbookData = null;

function applyTextbookSearch() {
    if (!textbookData) return;
    const term = (document.getElementById('textbook-search')?.value || '').trim().toLowerCase();

    if (!term) {
        renderTextbooksGrid(textbookData);
        return;
    }

    const filteredStudents = textbookData.students.filter(s =>
        s.full_name.toLowerCase().includes(term) || s.student_id.toLowerCase().includes(term)
    );

    renderTextbooksGrid({ ...textbookData, students: filteredStudents });
}

function setupTextbookSearch() {
    const search = document.getElementById('textbook-search');
    if (search) search.addEventListener('input', applyTextbookSearch);
}

async function loadTextbooksGrid() {
    const output = document.getElementById('textbooks-output');
    if (!output) return;

    // Only show "Loading..." the very first time (no data yet). On every
    // later refresh — after Issue/Return/Lost/Undo — re-rendering the
    // table in place keeps the container's scroll position where it was,
    // instead of blanking it out and snapping back to the top.
    if (!textbookData) {
        output.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Loading...</p>';
    }
    setupTextbookSearch();

    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/textbooks?teacher_id=${CURRENT_TEACHER_ID}`);
        const data = await res.json();

        if (!res.ok) {
            // Only replace the view with an error if there's nothing to fall
            // back on. If this was a refresh after Issue/Return/Lost and the
            // table is already showing the previous successful load, a
            // transient failure here shouldn't wipe out a working table the
            // teacher can still read and act on.
            if (!textbookData) {
                output.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${data.error || 'Could not load textbook data.'}</p>`;
            } else {
                console.error("Textbook refresh failed, keeping previous data visible:", data.error);
            }
            return;
        }

        textbookData = data;
        renderTextbooksGrid(data);
    } catch (err) {
        console.error("Textbooks load error:", err);
        if (!textbookData) {
            output.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not connect to server.</p>';
        }
    }
}

function renderTextbooksGrid(data) {
    const output = document.getElementById('textbooks-output');
    if (!output) return;

    if (!data.students || data.students.length === 0) {
        output.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No students found in your section.</p>';
        return;
    }

    // Re-rendering replaces the DOM nodes inside the scroll container,
    // which resets that container's scrollTop/scrollLeft to 0 by default.
    // Capture both before rendering and restore them after, so issuing,
    // returning, or marking a book for someone near the bottom (or far
    // right, on a wide subject list) doesn't snap the view back to the
    // top-left every time.
    const existingScroller = output.querySelector('.textbook-table-scroll');
    const previousScrollTop = existingScroller ? existingScroller.scrollTop : 0;
    const previousScrollLeft = existingScroller ? existingScroller.scrollLeft : 0;

    const headerCells = data.subjects.map(s => `<th>${s.subject_name}</th>`).join('');

    const rows = data.students.map(student => {
        const cells = student.books.map(book => {
            if (book.returned) {
                return `<td><span class="textbook-badge textbook-returned">Returned</span></td>`;
            }
            if (book.lost) {
                return `<td>
                    <span class="textbook-badge textbook-lost">Lost</span>
                    <button class="textbook-action-btn textbook-action-undo" onclick="undoTextbookLost('${student.student_id}', ${book.subject_id})">Undo Lost</button>
                </td>`;
            }
            if (book.issued) {
                return `<td>
                    <span class="textbook-badge textbook-issued">Issued</span>
                    <button class="textbook-action-btn" onclick="returnTextbook('${student.student_id}', ${book.subject_id})">Mark Returned</button>
                    <button class="textbook-action-btn textbook-action-lost" onclick="markTextbookLost('${student.student_id}', ${book.subject_id})">Mark Lost</button>
                </td>`;
            }
            return `<td>
                <button class="textbook-action-btn" onclick="issueTextbook('${student.student_id}', ${book.subject_id})">Issue</button>
            </td>`;
        }).join('');
        return `<tr><td>${student.full_name}</td>${cells}</tr>`;
    }).join('');

    // .textbook-table-scroll is this grid's own bounded scroll container —
    // needed so the sticky <thead> (freeze header) and sticky first
    // column (freeze Student name) below actually have a correctly-sized
    // scrolling ancestor to stick within, instead of silently doing
    // nothing (which is what a plain overflow-x:auto div gave us before).
    output.innerHTML = `
        <div class="textbook-table-scroll">
            <table id="progress-table">
                <thead><tr><th>Student</th>${headerCells}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;

    const newScroller = output.querySelector('.textbook-table-scroll');
    if (newScroller) {
        newScroller.scrollTop = previousScrollTop;
        newScroller.scrollLeft = previousScrollLeft;
    }

    // The Push-to-Academic-VP widget reflects the section currently loaded
    // in this grid, so refresh it every time the grid re-renders (after
    // load, issue, return, or marking lost) rather than only once on page load.
    loadTextbookPushStatus();
}

window.issueTextbook = async (student_id, subject_id) => {
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/textbooks/issue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID, student_id, subject_id })
        });
        const result = await res.json();
        if (!res.ok) {
            showAlertModal(result.error || "Could not issue textbook.");
            return;
        }
        await loadTextbooksGrid();
    } catch (err) {
        console.error("Issue textbook error:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.returnTextbook = async (student_id, subject_id) => {
    const confirmed = await showConfirmModal("Mark this textbook as returned?");
    if (!confirmed) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/textbooks/return`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID, student_id, subject_id })
        });
        const result = await res.json();
        if (!res.ok) {
            showAlertModal(result.error || "Could not mark as returned.");
            return;
        }
        await loadTextbooksGrid();
    } catch (err) {
        console.error("Return textbook error:", err);
        showAlertModal("Could not connect to server.");
    }
};

// Marks a textbook as lost — distinct from "returned". Can be undone via
// "Undo Lost" below as long as this section's report hasn't been pushed
// to Admin VP yet for this school year.
window.markTextbookLost = async (student_id, subject_id) => {
    const confirmed = await showConfirmModal(
        "This marks the book as lost for this student — it won't count as returned. You can undo this later (before the textbook report is pushed to Admin VP) if it was a mistake.",
        "Mark this textbook as lost?"
    );
    if (!confirmed) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/textbooks/lost`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID, student_id, subject_id })
        });
        const result = await res.json();
        if (!res.ok) {
            showAlertModal(result.error || "Could not mark as lost.");
            return;
        }
        await loadTextbooksGrid();
    } catch (err) {
        console.error("Mark lost error:", err);
        showAlertModal("Could not connect to server.");
    }
};

// Reverts a "lost" mark back to "issued". Blocked server-side once the
// section's report has already been pushed to Admin VP.
window.undoTextbookLost = async (student_id, subject_id) => {
    const confirmed = await showConfirmModal("This will put the textbook back to 'Issued' status. Continue?", "Undo Lost status?");
    if (!confirmed) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/textbooks/undo-lost`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID, student_id, subject_id })
        });
        const result = await res.json();
        if (!res.ok) {
            showAlertModal(result.error || "Could not undo lost status.");
            return;
        }
        await loadTextbooksGrid();
    } catch (err) {
        console.error("Undo lost error:", err);
        showAlertModal("Could not connect to server.");
    }
};

// PUSH TEXTBOOK REPORT TO ACADEMIC VP (homeroom teachers only)
async function loadTextbookPushStatus() {
    const container = document.getElementById('textbook-push-status');
    if (!container) return; // page markup not present (e.g. not a homeroom teacher)

    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/textbooks/push-status?teacher_id=${CURRENT_TEACHER_ID}`);
        const data = await res.json();

        if (!res.ok) {
            container.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${data.error || 'Could not load push status.'}</p>`;
            return;
        }

        renderTextbookPushStatus(data);
    } catch (err) {
        console.error("Textbook push-status load error:", err);
        container.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not connect to server.</p>';
    }
}

function renderTextbookPushStatus(data) {
    const container = document.getElementById('textbook-push-status');
    if (!container) return;

    if (data.already_pushed) {
        container.innerHTML = `
            <div class="conduct-card">
                <span class="push-status push-status-locked">
                    &#128274; Pushed to Admin VP on ${new Date(data.pushed_at).toLocaleDateString()}
                </span>
                <p style="font-size:0.85rem; color:#64748b; margin-top:8px;">
                    ${data.returned_count} returned, ${data.lost_count} lost, ${data.outstanding_count} outstanding out of ${data.total_slots} total at the time of push.
                </p>
            </div>`;
        return;
    }

    const meetsThreshold = data.percent_resolved >= 90;
    const barColor = meetsThreshold ? '#16a34a' : '#dc2626';

    container.innerHTML = `
        <div class="conduct-card">
            <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;">
                <strong>${data.percent_resolved}% resolved</strong>
                <span style="font-size:0.85rem; color:#64748b;">${data.returned_count} returned · ${data.lost_count} lost · ${data.outstanding_count} outstanding</span>
            </div>
            <div style="background:#e2e8f0; border-radius:6px; height:8px; overflow:hidden; margin-bottom:12px;">
                <div style="background:${barColor}; height:100%; width:${Math.min(data.percent_resolved, 100)}%;"></div>
            </div>
            <button class="btn-primary push-btn" onclick="pushTextbookReport()">
                Push Textbook Report to Admin VP
            </button>
            ${!meetsThreshold ? `<p style="font-size:0.8rem; color:#dc2626; margin-top:8px;">
                Needs at least 90% resolved (Returned or Lost) before this can be pushed. ${data.outstanding_count} book slot(s) still outstanding.
            </p>` : ''}
        </div>`;
}

window.pushTextbookReport = async () => {
    // Re-fetch the latest status right before deciding what to show, so the
    // confirm/blocked dialog always reflects current numbers even if the
    // teacher took an action and then immediately clicked Push.
    let data;
    try {
        const statusRes = await apiFetch(`${API_BASE}/api/homeroom/textbooks/push-status?teacher_id=${CURRENT_TEACHER_ID}`);
        data = await statusRes.json();
        if (!statusRes.ok) {
            showAlertModal(data.error || "Could not check push status.");
            return;
        }
    } catch (err) {
        console.error("Push status check error:", err);
        showAlertModal("Could not connect to server.");
        return;
    }

    if (data.percent_resolved < 90) {
        showAlertModal(
            `Only ${data.percent_resolved}% of textbooks are marked Returned or Lost (need at least 90%). ` +
            `${data.outstanding_count} of ${data.total_slots} book slot(s) are still outstanding. ` +
            `Issue, return, or mark lost the remaining books before pushing.`,
            "Can't push yet"
        );
        return;
    }

    const confirmed = await showConfirmModal(
        `${data.returned_count} returned, ${data.lost_count} lost, ${data.outstanding_count} still outstanding out of ${data.total_slots} total. ` +
        `This sends the report to Admin VP and can't be pushed again for this section/year afterward. Proceed?`,
        "Push textbook report to Admin VP?"
    );
    if (!confirmed) return;

    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/textbooks/push-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID })
        });
        const result = await res.json();

        if (!res.ok) {
            showAlertModal(result.error || "Could not push report.");
            return;
        }

        showSuccessModal(result.message);
        await loadTextbookPushStatus();
    } catch (err) {
        console.error("Push textbook report error:", err);
        showAlertModal("Could not connect to server.");
    }
};

// PUSH MARKS REPORT TO ACADEMIC VP (homeroom teachers only)
// Separate from the textbook push (which goes to Admin VP) — this
// forwards the section's compiled marks once every subject in the
// stream has been pushed by its own subject teacher (100% required,
// not a partial threshold like the textbook push).
async function loadMarksPushStatus() {
    const container = document.getElementById('marks-push-status');
    if (!container) return;

    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/marks/push-status?teacher_id=${CURRENT_TEACHER_ID}`);
        const data = await res.json();

        if (!res.ok) {
            container.innerHTML = `<p style="color:#64748b; font-size:0.85rem;">${data.error || 'Could not load marks push status.'}</p>`;
            return;
        }

        renderMarksPushStatus(data);
    } catch (err) {
        console.error("Marks push-status load error:", err);
        container.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not connect to server.</p>';
    }
}

function renderMarksPushStatus(data) {
    const container = document.getElementById('marks-push-status');
    if (!container) return;

    if (data.already_pushed) {
        container.innerHTML = `
            <div class="conduct-card">
                <span class="push-status push-status-locked">
                    &#128274; Pushed to Academic VP on ${new Date(data.pushed_at).toLocaleDateString()}
                </span>
                <p style="font-size:0.85rem; color:#64748b; margin-top:8px;">
                    All ${data.total_subjects} subject(s) were included for ${data.term}.
                </p>
            </div>`;
        return;
    }

    const meetsThreshold = data.pushed_subjects >= data.total_subjects && data.total_subjects > 0;
    const barColor = meetsThreshold ? '#16a34a' : '#dc2626';

    container.innerHTML = `
        <div class="conduct-card">
            <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;">
                <strong>${data.pushed_subjects} of ${data.total_subjects} subjects pushed</strong>
                <span style="font-size:0.85rem; color:#64748b;">${data.percent_pushed}%</span>
            </div>
            <div style="background:#e2e8f0; border-radius:6px; height:8px; overflow:hidden; margin-bottom:12px;">
                <div style="background:${barColor}; height:100%; width:${Math.min(data.percent_pushed, 100)}%;"></div>
            </div>
            <button class="btn-primary push-btn" onclick="pushMarksReport()" ${!meetsThreshold ? 'disabled' : ''}>
                Push ${data.term} Marks to Academic VP
            </button>
            ${!meetsThreshold ? `<p style="font-size:0.8rem; color:#dc2626; margin-top:8px;">
                Still waiting on: ${(data.not_pushed_subjects || []).join(', ') || 'all subjects'}.
            </p>` : ''}
        </div>`;
}

window.pushMarksReport = async () => {
    // Re-check right before showing the confirm dialog, in case a subject
    // teacher pushed their report in the time since this page loaded.
    let data;
    try {
        const statusRes = await apiFetch(`${API_BASE}/api/homeroom/marks/push-status?teacher_id=${CURRENT_TEACHER_ID}`);
        data = await statusRes.json();
        if (!statusRes.ok) {
            showAlertModal(data.error || "Could not check push status.");
            return;
        }
    } catch (err) {
        console.error("Marks push status check error:", err);
        showAlertModal("Could not connect to server.");
        return;
    }

    if (data.pushed_subjects < data.total_subjects) {
        showAlertModal(
            `Not all subjects have been pushed yet (${data.pushed_subjects} of ${data.total_subjects}). ` +
            `Still waiting on: ${(data.not_pushed_subjects || []).join(', ')}.`,
            "Can't push yet"
        );
        return;
    }

    const confirmed = await showConfirmModal(
        `All ${data.total_subjects} subject(s) for ${data.term} have been pushed by their teachers. This sends the compiled section report to Academic VP and can't be pushed again for this section/term afterward. Proceed?`,
        "Push marks report to Academic VP?"
    );
    if (!confirmed) return;

    try {
        const res = await apiFetch(`${API_BASE}/api/homeroom/marks/push-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID })
        });
        const result = await res.json();

        if (!res.ok) {
            showAlertModal(result.error || "Could not push marks report.");
            return;
        }

        showSuccessModal(result.message);
        await loadMarksPushStatus();
    } catch (err) {
        console.error("Push marks report error:", err);
        showAlertModal("Could not connect to server.");
    }
};

// CONTACT SCHOOL MANAGEMENT
// Load teacher's sections into the notify-students dropdown
async function loadMysections() {
    const select = document.getElementById('notif-student-section');
    if (!select) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/my-sections`);
        if (!res.ok) return;
        const sections = await res.json();
        select.innerHTML = '<option value="">Select section…</option>' +
            sections.map(s => `<option value="${s.class_level}|${s.section}|${s.stream}">Grade ${s.class_level} - ${s.section} (${s.stream})</option>`).join('');
    } catch (err) {
        console.error("loadMysections error:", err);
    }
}

window.sendStudentNotification = async () => {
    const sectionVal = document.getElementById('notif-student-section').value;
    const assessmentTypeSelect = document.getElementById('notif-assessment-type');
    const assessment_type = assessmentTypeSelect.value;
    // Use the human-readable option label ("Individual Assignment 1") in
    // user-facing text, not the raw underscored value sent to the API.
    const assessmentTypeText = assessmentTypeSelect.options[assessmentTypeSelect.selectedIndex]?.text || assessment_type;
    const message = document.getElementById('notif-student-message').value.trim();
    const preview = document.getElementById('notif-student-preview');

    if (!sectionVal || !assessment_type || !message) {
        showAlertModal("Please select a section, assessment type, and enter a message.");
        return;
    }

    const [class_level, section, stream] = sectionVal.split('|');
    const confirmed = await showConfirmModal(
        `Send a "${assessmentTypeText}" reminder to all students in Grade ${class_level} - ${section} who haven't completed it yet?`,
        "Notify Students"
    );
    if (!confirmed) return;

    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/notify-students`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ class_level, section, stream, assessment_type, message })
        });
        const data = await res.json();
        if (!res.ok) { showAlertModal(data.error || "Could not send notification."); return; }

        showSuccessModal(data.message);
        if (preview) {
            preview.textContent = data.notified > 0
                ? `Notified: ${data.students.join(', ')}`
                : '';
        }
        document.getElementById('notif-student-message').value = '';
    } catch (err) {
        showAlertModal("Could not connect to server.");
    }
};

window.sendAbsenceRequest = async () => {
    const date_from = document.getElementById('absence-date-from').value;
    const date_to = document.getElementById('absence-date-to').value;
    const reason = document.getElementById('absence-reason').value.trim();

    if (!date_from || !date_to || !reason) {
        showAlertModal("Please fill in the absence dates and reason.");
        return;
    }

    try {
        const res = await apiFetch(`${API_BASE}/api/contact/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                teacher_id: CURRENT_TEACHER_ID,
                recipient_role: 'Admin VP',
                cc_roles: ['Academic VP', 'Principal'],
                category: 'Permission Request',
                subject: `Absence Request: ${date_from} to ${date_to}`,
                body: `Absence requested from ${date_from} to ${date_to}.\n\nReason: ${reason}`
            })
        });
        const result = await res.json();
        if (!res.ok) {
            showAlertModal(result.error || "Could not send absence request.");
            return;
        }

        showSuccessModal("Your absence request has been sent to the Admin VP. Academic VP and Principal have been tagged.");
        document.getElementById('absence-date-from').value = '';
        document.getElementById('absence-date-to').value = '';
        document.getElementById('absence-reason').value = '';
        loadContactThreads();
    } catch (err) {
        console.error("Send absence request error:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.sendContactMessage = async () => {
    const recipient_role = document.getElementById('contact-recipient').value;
    const category = document.getElementById('contact-category').value;
    const subject = document.getElementById('contact-subject').value.trim();
    const body = document.getElementById('contact-body').value.trim();

    if (!subject || !body) {
        showAlertModal("Please fill in both subject and message.");
        return;
    }

    try {
        const res = await apiFetch(`${API_BASE}/api/contact/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID, recipient_role, category, subject, body })
        });
        const result = await res.json();
        if (!res.ok) {
            showAlertModal(result.error || "Could not send message.");
            return;
        }

        showSuccessModal("Your message has been sent.");
        document.getElementById('contact-subject').value = '';
        document.getElementById('contact-body').value = '';
        loadContactThreads();
    } catch (err) {
        console.error("Send contact message error:", err);
        showAlertModal("Could not connect to server.");
    }
};

async function loadContactThreads() {
    const list = document.getElementById('contact-thread-list');
    if (!list) return;

    try {
        const res = await apiFetch(`${API_BASE}/api/contact/my-threads?teacher_id=${CURRENT_TEACHER_ID}`);
        if (!res.ok) throw new Error("Could not load messages");
        const threads = await res.json();

        if (threads.length === 0) {
            list.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No messages sent yet.</p>';
            return;
        }

        list.innerHTML = threads.map(t => `
            <div class="contact-thread-row" onclick="openContactThread(${t.thread_id})">
                <div>
                    <strong>${t.subject}</strong>
                    <span class="contact-thread-meta">${t.category} → ${t.recipient_role}${t.cc_roles && t.cc_roles.length ? ` (cc: ${t.cc_roles.join(', ')})` : ''}</span>
                </div>
                <span class="contact-status contact-status-${t.status.toLowerCase()}">${t.status}</span>
            </div>`).join('');
    } catch (err) {
        console.error("Load contact threads error:", err);
        list.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not load messages.</p>';
    }
}

let currentThreadId = null;

window.openContactThread = async (thread_id) => {
    currentThreadId = thread_id;
    const detail = document.getElementById('contact-thread-detail');
    const content = document.getElementById('contact-thread-content');
    if (!detail || !content) return;

    detail.style.display = 'block';
    content.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Loading...</p>';

    try {
        const res = await apiFetch(`${API_BASE}/api/contact/thread/${thread_id}?teacher_id=${CURRENT_TEACHER_ID}`);
        if (!res.ok) throw new Error("Could not load thread");
        const { thread, messages } = await res.json();

        const messagesHtml = messages.map(m => `
            <div class="contact-message ${m.sender_role === 'teacher' ? 'contact-message-mine' : 'contact-message-theirs'}">
                <div class="contact-message-meta">${m.sender_role === 'teacher' ? 'You' : thread.recipient_role} — ${new Date(m.sent_at).toLocaleString()}</div>
                <div>${m.body}</div>
            </div>`).join('');

        content.innerHTML = `
            <h3>${thread.subject}</h3>
            <p style="font-size:0.85rem; color:#64748b;">${thread.category} → ${thread.recipient_role}${thread.cc_roles && thread.cc_roles.length ? ` <span style="color:#94a3b8;">(cc: ${thread.cc_roles.join(', ')})</span>` : ''}</p>
            <div class="contact-thread-messages">${messagesHtml}</div>
            <textarea id="contact-reply-body" class="form-input" rows="3" placeholder="Write a reply..."></textarea>
            <div style="display:flex; gap:10px;">
                <button class="btn-primary" onclick="sendContactReply()" style="width:auto; padding:10px 20px;">Reply</button>
                <button class="btn-primary" onclick="toggleContactStatus('${thread.status === 'Open' ? 'Resolved' : 'Open'}')" style="width:auto; padding:10px 20px; background:#64748b;">
                    Mark as ${thread.status === 'Open' ? 'Resolved' : 'Open'}
                </button>
            </div>`;
    } catch (err) {
        console.error("Open contact thread error:", err);
        content.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Could not load this conversation.</p>';
    }
};

window.closeContactThread = () => {
    currentThreadId = null;
    const detail = document.getElementById('contact-thread-detail');
    if (detail) detail.style.display = 'none';
};

window.sendContactReply = async () => {
    if (!currentThreadId) return;
    const bodyInput = document.getElementById('contact-reply-body');
    const body = bodyInput.value.trim();
    if (!body) return showAlertModal("Please write a message before sending.");

    try {
        const res = await apiFetch(`${API_BASE}/api/contact/thread/${currentThreadId}/reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID, body })
        });
        const result = await res.json();
        if (!res.ok) {
            showAlertModal(result.error || "Could not send reply.");
            return;
        }
        await openContactThread(currentThreadId);
        await loadContactThreads();
    } catch (err) {
        console.error("Send contact reply error:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.toggleContactStatus = async (newStatus) => {
    if (!currentThreadId) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/contact/thread/${currentThreadId}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID, status: newStatus })
        });
        const result = await res.json();
        if (!res.ok) {
            showAlertModal(result.error || "Could not update status.");
            return;
        }
        await openContactThread(currentThreadId);
        await loadContactThreads();
    } catch (err) {
        console.error("Toggle contact status error:", err);
        showAlertModal("Could not connect to server.");
    }
};

// NAVIGATION
function setupNavigation() {
    // Exclude external links (e.g. "Back to School Website") so they
    // navigate normally instead of being captured by internal page routing.
    const navLinks = document.querySelectorAll('.nav-link:not(.nav-external)');
    const pages = document.querySelectorAll('.page-content');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();

            // currentTarget, not target — protects against icons/spans
            // inside the link stealing the click target later on
            const clicked = e.currentTarget;

            navLinks.forEach(l => l.classList.remove('active'));
            clicked.classList.add('active');

            pages.forEach(p => p.style.display = 'none');
            if (typeof closeQrScanner === 'function') closeQrScanner();

            const target = clicked.getAttribute('data-page');
            const targetPage = document.getElementById(`page-${target}`);
            if (targetPage) {
                targetPage.style.display = 'block';
                if (target === 'textbooks') loadTextbooksGrid();
                if (target === 'myclass') loadMyClassRoster();
                if (target === 'contact') { loadContactThreads(); loadMysections(); }
                if (target === 'idcard') loadTeacherIdCard();
                if (target === 'actioncenter') loadActionCenterRequests();
                if (target === 'upload') loadGradeSheetSections();
                if (target === 'profile') loadTeacherDocumentStatus();
            } else {
                console.warn(`No page found for data-page="${target}". Did you forget to add <section id="page-${target}">?`);
            }

            const drop = document.getElementById('profile-dropdown');
            if (drop) drop.style.display = 'none';

            // On mobile the sidebar overlays the content rather than living
            // beside it, so picking a destination should also close it —
            // otherwise the menu just sits open over the page you navigated to.
            closeSidebar();
        });
    });
}

// Mobile sidebar: opens as an overlay (rather than the permanent side
// column used on wider screens — see the @media rules in style.css).
// aria-expanded is kept in sync on the toggle button so screen readers
// know whether the menu is currently open.
function setupSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const overlay = document.getElementById('sidebar-overlay');
    if (!sidebar || !toggleBtn || !overlay) return;

    toggleBtn.addEventListener('click', () => {
        const isOpen = sidebar.classList.toggle('sidebar-open');
        overlay.classList.toggle('sidebar-overlay-visible', isOpen);
        toggleBtn.setAttribute('aria-expanded', String(isOpen));
        toggleBtn.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
    });

    overlay.addEventListener('click', closeSidebar);

    // Esc closes the mobile menu too, same as the modals below.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSidebar();
    });
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const overlay = document.getElementById('sidebar-overlay');
    if (!sidebar || !sidebar.classList.contains('sidebar-open')) return;

    sidebar.classList.remove('sidebar-open');
    if (overlay) overlay.classList.remove('sidebar-overlay-visible');
    if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.setAttribute('aria-label', 'Open navigation menu');
    }
}

// If the window grows back past the mobile breakpoint while the overlay
// menu happens to be open (e.g. rotating a tablet, or resizing a browser
// window), close it — the sidebar becomes a permanent column again at
// that width and the overlay/backdrop state would otherwise look stuck.
window.addEventListener('resize', () => {
    if (window.innerWidth > 900) closeSidebar();
});

// Pressing Enter in the relevant input triggers the same action as
// clicking its button — search-id -> Search, score-input -> Submit.
function setupEnterKeySubmission() {
    const searchInput = document.getElementById('search-id');
    if (searchInput) {
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                window.searchStudent();
            }
        });
    }

    const scoreInput = document.getElementById('score-input');
    if (scoreInput) {
        scoreInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                window.submitIndividualMark();
            }
        });
    }
}

// DASHBOARD STATS
// Dashboard stats are now derived client-side from the teacher's own
// scoped student list (see renderStudentTableAndStats), not a separate
// school-wide /api/student-stats call, so counts always match what the
// teacher can actually see and stay correct when filters are applied.

// STUDENTS LIST
let allMyStudents = [];

const loadStudents = async () => {
    try {
        // Use the teacher's ID to fetch only their assigned students
        const res = await apiFetch(`${API_BASE}/api/teacher/my-students?teacher_id=${CURRENT_TEACHER_ID}`);
        if (!res.ok) throw new Error("Could not load your assigned students");

        allMyStudents = await res.json();
        populateStudentFilterOptions(allMyStudents);
        renderStudentTableAndStats(allMyStudents);
    } catch (err) {
        console.error("Error loading students:", err);
    }
};

// Builds the Class and Section dropdown options from whatever classes/
function populateStudentFilterOptions(students) {
    const classSelect = document.getElementById('student-filter-class');
    const sectionSelect = document.getElementById('student-filter-section');
    if (!classSelect || !sectionSelect) return;

    const classes = [...new Set(students.map(s => s.class_level))].sort((a, b) => a - b);
    const sections = [...new Set(students.map(s => s.section))].sort();

    classSelect.innerHTML = '<option value="">All Classes</option>' +
        classes.map(c => `<option value="${c}">Grade ${c}</option>`).join('');
    sectionSelect.innerHTML = '<option value="">All Sections</option>' +
        sections.map(s => `<option value="${s}">${s}</option>`).join('');
}

// Renders both the table rows AND the 3 stat cards from the SAME filtered
// list, so the counts always exactly match what's visible in the table —
// scoped to this teacher's own students, and further scoped down whenever
// a search term or filter is applied.
function renderStudentTableAndStats(students) {
    const tbody = document.getElementById('student-table-body');
    if (tbody) {
        tbody.innerHTML = students.map(s => `
            <tr>
                <td>${s.student_id}</td>
                <td>${[s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ')}</td>
                <td>${s.sex}</td>
                <td>${s.class_level}</td>
                <td>${s.section}</td>
                <td>${s.stream}</td>
                <td>
                    <button onclick="viewStudentProgress('${s.student_id}', '${s.stream}')">
                        View
                    </button>
                </td>
            </tr>`).join('');
    }

    const totalEl = document.getElementById('total-count');
    const femaleEl = document.getElementById('female-count');
    const maleEl = document.getElementById('male-count');
    if (totalEl) totalEl.textContent = students.length;
    if (femaleEl) femaleEl.textContent = students.filter(s => s.sex === 'Female').length;
    if (maleEl) maleEl.textContent = students.filter(s => s.sex === 'Male').length;
}

// Applies the search box + class/section dropdowns together against the
// full list this teacher is assigned to, then re-renders table + stats.
function applyStudentFilters() {
    const searchTerm = (document.getElementById('student-search')?.value || '').trim().toLowerCase();
    const classFilter = document.getElementById('student-filter-class')?.value || '';
    const sectionFilter = document.getElementById('student-filter-section')?.value || '';

    const filtered = allMyStudents.filter(s => {
        if (classFilter && String(s.class_level) !== classFilter) return false;
        if (sectionFilter && s.section !== sectionFilter) return false;
        if (searchTerm) {
            const fullName = [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ').toLowerCase();
            if (!fullName.includes(searchTerm) && !s.student_id.toLowerCase().includes(searchTerm)) {
                return false;
            }
        }
        return true;
    });

    renderStudentTableAndStats(filtered);
}

function setupStudentFilters() {
    const search = document.getElementById('student-search');
    const classSelect = document.getElementById('student-filter-class');
    const sectionSelect = document.getElementById('student-filter-section');

    if (search) search.addEventListener('input', applyStudentFilters);
    if (classSelect) classSelect.addEventListener('change', applyStudentFilters);
    if (sectionSelect) sectionSelect.addEventListener('change', applyStudentFilters);
}

// SUBJECTS DROPDOWN
const loadSubjects = async () => {
    try {
        const res = await apiFetch(`${API_BASE}/api/subjects`);
        if (!res.ok) throw new Error("Could not load subjects");
        const subjects = await res.json();
        const select = document.getElementById('subject-select');
        if (!select) return;

        // Only replace the hardcoded HTML options if the API actually
        // returned something usable — otherwise keep the static fallback
        // list that's already in the markup.
        if (Array.isArray(subjects) && subjects.length > 0) {
            select.innerHTML = '<option value="">Select a Subject</option>';
            subjects.forEach(sub => {
                const option = document.createElement('option');
                option.value = sub.subject_id;
                option.textContent = sub.subject_name;
                select.appendChild(option);
            });
        }
    } catch (err) {
        console.error("Could not load subjects (keeping static fallback list):", err);
    }
};

// PROFILE — single definition, fully populated
async function loadProfileData() {
    try {
        const response = await apiFetch(`${API_BASE}/api/teacher/full-profile?teacher_id=${CURRENT_TEACHER_ID}`);
        if (!response.ok) throw new Error("Could not load profile");
        const data = await response.json();

        setText('profile-name', data.full_name || "N/A");
        setText('profile-id', data.teacher_id);
        setValue('profile-contact', data.contact_number || "");

        const displayEl = document.getElementById('profile-contact-display');
        if (displayEl) displayEl.textContent = data.contact_number || '—';

        // Greet the teacher by first name in the header
        const greeting = document.getElementById('nav-greeting');
        if (greeting && data.full_name) {
            greeting.textContent = `Hi, ${data.full_name.split(' ')[0]}!`;
        }

        const navAvatar = document.getElementById('nav-avatar');
        const navAvatarInitials = document.getElementById('nav-avatar-initials');
        if (data.avatar_url && navAvatar) {
            navAvatar.src = data.avatar_url;
            navAvatar.style.display = '';
            if (navAvatarInitials) navAvatarInitials.style.display = 'none';
        } else {
            if (navAvatar) navAvatar.style.display = 'none';
            if (navAvatarInitials) {
                navAvatarInitials.textContent = (data.full_name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
                navAvatarInitials.style.display = 'flex';
            }
        }

        const profileImg = document.getElementById('profile-img');
        const initialsEl = document.getElementById('profile-avatar-initials');
        if (data.avatar_url && profileImg) {
            profileImg.src = data.avatar_url;
            profileImg.alt = data.full_name ? `Profile photo of ${data.full_name}` : "Profile photo";
            profileImg.style.display = '';
        } else if (initialsEl) {
            if (profileImg) profileImg.style.display = 'none';
            const initials = (data.full_name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
            initialsEl.textContent = initials;
            initialsEl.style.display = 'flex';
        }

        const streamsList = document.getElementById('profile-streams-list');
        if (streamsList) {
            const streams = data.streams && data.streams.length > 0 ? data.streams : ['N/A'];
            streamsList.innerHTML = streams.map(s => `<li>${s}</li>`).join('');
        }

        const subjectList = document.getElementById('profile-subjects-list');
        if (subjectList) {
            subjectList.innerHTML = data.subjects && data.subjects.length > 0
                ? data.subjects.map(s => `<li>${s}</li>`).join('')
                : '<li>No subjects assigned</li>';
        }
    } catch (err) {
        console.error("Profile load error:", err);
    }
}

// Small null-safe helpers
function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}
function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
}

// TEACHER ID CARD ("My ID" page) — fetched once per page visit and
// re-rendered (not re-fetched) on language switch, since only the
// static labels change, not the underlying data.
let teacherIdCardData = null;

async function loadTeacherIdCard() {
    const errorEl = document.getElementById('idcard-error');
    const wrap = document.getElementById('idcard-wrap');
    const actions = document.getElementById('idcard-actions');
    if (!wrap) return;

    if (teacherIdCardData) {
        renderTeacherIdCard(teacherIdCardData);
        return;
    }

    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/id-card`);
        if (!res.ok) throw new Error("Could not load ID card");
        const data = await res.json();
        teacherIdCardData = data;
        renderTeacherIdCard(data);
    } catch (err) {
        console.error("ID card load error:", err);
        if (errorEl) {
            errorEl.textContent = typeof t === 'function' ? t('idcard_could_not_load') : "Could not load your ID card.";
            errorEl.style.display = 'block';
        }
        if (wrap) wrap.style.display = 'none';
        if (actions) actions.style.display = 'none';
    }
}

function renderTeacherIdCard(data) {
    const wrap = document.getElementById('idcard-wrap');
    const actions = document.getElementById('idcard-actions');
    const errorEl = document.getElementById('idcard-error');
    if (!wrap) return;

    if (errorEl) errorEl.style.display = 'none';
    wrap.style.display = 'flex';
    if (actions) actions.style.display = 'flex';

    // The ID card itself is always bilingual (English + Amharic together)
    // regardless of the site-wide language switch — it's a printable
    // credential, not a page that should change depending on which tab
    // was last clicked.
    const zoneLabel = data.zone ? `${data.zone.toUpperCase()} ZONE` : 'ZONE —';
    const woredaLabel = data.woreda || '—';
    setText('idcard-zone-front', zoneLabel);
    setText('idcard-zone-back', zoneLabel);
    setText('idcard-woreda-front', woredaLabel);
    setText('idcard-woreda-back', woredaLabel);
    setText('idcard-school-name-front', data.school_name || '—');
    setText('idcard-name', data.full_name || '—');
    setText('idcard-teacher-id', data.teacher_id || '—');
    setText('idcard-subject', data.subject || 'General / አጠቃላይ');
    setText('idcard-valid-until', data.valid_until || '—');
    setText('idcard-phone', data.contact_number || '—');
    setText('idcard-email', data.email || '—');
    setText('idcard-address', data.school_address || 'Not set / አልተመዘገበም');

    const photo = document.getElementById('idcard-photo');
    const placeholder = document.getElementById('idcard-photo-placeholder');
    if (data.avatar_url && photo) {
        photo.src = data.avatar_url;
        photo.alt = data.full_name ? `Photo of ${data.full_name}` : 'Teacher photo';
        photo.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
    } else {
        if (photo) photo.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
    }

    renderIdCardQrCode(data.qr_payload || data.teacher_id || '');
}

// Real, scannable QR code encoding the server-signed "<teacher_id>.<signature>"
// payload (same signing scheme already used for student QR check-in — see
// signQrPayload/verifyQrPayload on the server) so the card can eventually be
// scanned for verification/attendance, unlike the old decorative bar pattern.
function renderIdCardQrCode(payload) {
    const container = document.getElementById('idcard-qrcode');
    if (!container) return;
    container.innerHTML = '';
    if (typeof qrcode !== 'function' || !payload) return;

    const qr = qrcode(0, 'M'); // type 0 = auto-detect smallest size that fits the data
    qr.addData(String(payload));
    qr.make();
    container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
}

window.flipIdCard = () => {
    const flipper = document.getElementById('idcard-flipper');
    if (flipper) flipper.classList.toggle('idcard-flipped');
};

window.printIdCard = () => {
    window.print();
};


window.toggleContactEdit = (forceOpen) => {
    const panel = document.getElementById('profile-contact-edit');
    const input = document.getElementById('profile-contact');
    if (!panel) return;
    const open = forceOpen !== undefined ? forceOpen : panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    if (open && input) input.focus();
};

window.saveProfileChanges = async () => {
    const contact = document.getElementById('profile-contact').value.trim();
    try {
        const response = await apiFetch(`${API_BASE}/api/teacher/update-profile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID, contact_number: contact })
        });
        if (response.ok) {
            // Update the inline display and close the edit panel
            const displayEl = document.getElementById('profile-contact-display');
            if (displayEl) displayEl.textContent = contact || '—';
            toggleContactEdit(false);
            showSuccessModal("Contact number updated.");
        } else {
            showAlertModal("Failed to update profile.");
        }
    } catch (err) {
        console.error("Error saving profile:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.updatePassword = async () => {
    // teacher_id comes from CURRENT_TEACHER_ID, populated at page load via
    // /api/me using the auth cookie — not from localStorage.
    const teacher_id = CURRENT_TEACHER_ID;
    const currentPass = document.getElementById('curr-pass').value;
    const newPass = document.getElementById('new-pass').value;
    const confirmPass = document.getElementById('confirm-pass').value;

    if (newPass !== confirmPass) {
        showAlertModal("New passwords do not match!");
        return;
    }

    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/update-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // 2. Send teacher_id along with the passwords
            body: JSON.stringify({ teacher_id, currentPass, newPass })
        });

        if (res.ok) {
            showAlertModal("Password updated successfully!");
            // Clear inputs
            document.getElementById('curr-pass').value = '';
            document.getElementById('new-pass').value = '';
            document.getElementById('confirm-pass').value = '';
        } else {
            const errorData = await res.json();
            showAlertModal(errorData.error || "Failed to update password.");
        }
    } catch (err) {
        console.error("Error updating password:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.uploadAvatar = async () => {
    const fileInput = document.getElementById('avatar-upload');
    const file = fileInput.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('teacher_id', CURRENT_TEACHER_ID);

    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/update-avatar`, {
            method: 'POST',
            body: formData
        });
        if (res.ok) {
            const result = await res.json();
            const img = document.getElementById('profile-img');
            if (img) img.src = result.new_avatar_url;
        } else {
            const errorData = await res.json().catch(() => ({}));
            showAlertModal(errorData.error || "Failed to upload avatar.");
        }
    } catch (err) {
        console.error("Error uploading avatar:", err);
    }
};

// PROFILE — signature & ID photo, both pending Principal approval before
// they take effect. Reused rendering logic since the two document types
// only differ in which DOM elements and endpoint they use.
function renderApprovalBadge(badgeEl, reasonEl, status, rejectionReason) {
    if (!badgeEl) return;
    const statusKey = status || 'none';
    badgeEl.className = `approval-badge approval-badge-${statusKey}`;
    badgeEl.textContent = typeof t === 'function' ? t(`approval_status_${statusKey}`) : statusKey;
    if (reasonEl) {
        if (statusKey === 'rejected' && rejectionReason) {
            reasonEl.textContent = `Reason: ${rejectionReason}`;
            reasonEl.style.display = 'block';
        } else {
            reasonEl.style.display = 'none';
        }
    }
}

async function loadTeacherDocumentStatus() {
    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/document-status`);
        if (!res.ok) return;
        const data = await res.json();

        const sigImg = document.getElementById('signature-preview');
        const sigEmpty = document.getElementById('signature-preview-empty');
        if (data.signature_url && sigImg) {
            sigImg.src = data.signature_url;
            sigImg.style.display = 'block';
            if (sigEmpty) sigEmpty.style.display = 'none';
        } else if (sigEmpty) {
            if (sigImg) sigImg.style.display = 'none';
            sigEmpty.style.display = 'block';
        }
        renderApprovalBadge(
            document.getElementById('signature-status-badge'),
            document.getElementById('signature-rejection-reason'),
            data.signature_request?.status,
            data.signature_request?.rejection_reason
        );

        const idImg = document.getElementById('teacher-idphoto-preview');
        const idEmpty = document.getElementById('teacher-idphoto-preview-empty');
        if (data.id_photo_url && idImg) {
            idImg.src = data.id_photo_url;
            idImg.style.display = 'block';
            if (idEmpty) idEmpty.style.display = 'none';
        } else if (idEmpty) {
            if (idImg) idImg.style.display = 'none';
            idEmpty.style.display = 'block';
        }
        renderApprovalBadge(
            document.getElementById('idphoto-status-badge'),
            document.getElementById('idphoto-rejection-reason'),
            data.id_photo_request?.status,
            data.id_photo_request?.rejection_reason
        );
    } catch (err) {
        console.error("loadTeacherDocumentStatus error:", err);
    }
}

window.uploadTeacherSignature = async () => {
    const fileInput = document.getElementById('signature-upload');
    const file = fileInput.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('signature', file);

    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/upload-signature`, { method: 'POST', body: formData });
        const result = await res.json();
        if (!res.ok) {
            showAlertModal(result.error || "Could not submit your signature for approval.");
            return;
        }
        showAlertModal("Signature submitted — it will appear once the Principal approves it.");
        fileInput.value = '';
        await loadTeacherDocumentStatus();
    } catch (err) {
        console.error("Error uploading signature:", err);
        showAlertModal("Could not connect to server.");
    }
};

window.uploadTeacherIdPhoto = async () => {
    const fileInput = document.getElementById('teacher-idphoto-upload');
    const file = fileInput.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('photo', file);

    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/upload-id-photo`, { method: 'POST', body: formData });
        const result = await res.json();
        if (!res.ok) {
            showAlertModal(result.error || "Could not submit your ID photo for approval.");
            return;
        }
        showAlertModal("ID photo submitted — it will appear once the Principal approves it.");
        fileInput.value = '';
        await loadTeacherDocumentStatus();
    } catch (err) {
        console.error("Error uploading ID photo:", err);
        showAlertModal("Could not connect to server.");
    }
};

// PROFILE — notification/security checkboxes (single listener,
// event delegation so it's safe regardless of render timing)
function setupPreferenceListeners() {
    const profilePage = document.getElementById('page-profile');
    if (!profilePage) {
        console.warn("page-profile not found — preference toggles won't be wired up.");
        return;
    }

    profilePage.addEventListener('change', async (e) => {
        if (!e.target.matches('input[type="checkbox"]')) return;

        const prefName = e.target.id;
        const isChecked = e.target.checked;

        try {
            const response = await apiFetch(`${API_BASE}/api/teacher/update-preferences`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teacher_id: CURRENT_TEACHER_ID, preference: prefName, value: isChecked })
            });

            if (!response.ok) throw new Error("Server rejected preference update");
        } catch (err) {
            console.error("Error saving preference:", err);
            e.target.checked = !isChecked; // revert on failure
        }
    });
}

// STUDENT PROGRESS MODAL
window.viewStudentProgress = async (studentId, studentStream) => {
    try {
        // 1. Fetch ONLY the subjects assigned to THIS teacher for this stream
        // 2. Fetch the marks for the student
        const [subjectRes, marksRes] = await Promise.all([
            apiFetch(`${API_BASE}/api/teacher/my-subjects?teacher_id=${CURRENT_TEACHER_ID}&stream=${encodeURIComponent(studentStream)}`),
            apiFetch(`${API_BASE}/api/student-progress/${studentId}`)
        ]);

        if (!subjectRes.ok) throw new Error("Failed to load your assigned subjects.");
        if (!marksRes.ok) throw new Error("Failed to load student marks.");

        const subjects = await subjectRes.json();
        const marks = await marksRes.json();

        renderProgressTable(subjects, marks);

        // student-progress returns first_name/last_name on every row (it's
        // joined per-subject), so grab it from the first row instead of
        // showing the raw student_id.
        const nameEl = document.getElementById('modal-student-name');
        if (nameEl) {
            if (marks.length > 0) {
                const fullName = [marks[0].first_name, marks[0].middle_name, marks[0].last_name].filter(Boolean).join(' ');
                nameEl.textContent = `${fullName} (${studentStream})`;
            } else {
                nameEl.textContent = `${studentId} (${studentStream})`;
            }
        }
    } catch (err) {
        console.error("Error loading progress:", err);
        showAlertModal("Could not load your assigned subject progress.");
    }
};

const PROGRESS_FIELDS = [
    'individual_assignment_1', 'individual_assignment_2', 'group_assignment',
    'quiz', 'midterm', 'final'
];

function renderProgressTable(subjects, marks) {
    const tbody = document.getElementById('progress-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    let totalS1 = 0;
    let totalS2 = 0;

    // Dedupe subjects by name in case the subjects/teacher_assignments
    // tables have duplicate rows for the same subject.
    const seenNames = new Set();
    const uniqueSubjects = subjects.filter(subj => {
        if (seenNames.has(subj.subject_name)) return false;
        seenNames.add(subj.subject_name);
        return true;
    });

    uniqueSubjects.forEach(subj => {
        // Your subjects/marks data currently has duplicate subject_name rows
        // (same subject appearing 2-3x, likely duplicate rows in the subjects
        // table). A plain .find() would grab whichever duplicate comes first,
        // even if it's empty, and ignore a later duplicate that actually has
        // scores. This picks the best match: prefer a row with at least one
        // non-null score over an empty one.
        const candidates = marks.filter(m => m.subject_name === subj.subject_name);
        const item = candidates.find(m =>
            PROGRESS_FIELDS.some(f => m[`${f}_s1`] != null || m[`${f}_s2`] != null)
        ) || candidates[0] || {};

        const renderCell = (score) => score ? `<td>${score}</td>` : `<td class="shaded-blank">N/A</td>`;

        let cellsHtml = '';
        PROGRESS_FIELDS.forEach(field => {
            const s1 = item[`${field}_s1`];
            const s2 = item[`${field}_s2`];
            totalS1 += Number(s1) || 0;
            totalS2 += Number(s2) || 0;
            cellsHtml += renderCell(s1) + renderCell(s2);
        });

        tbody.innerHTML += `<tr>
            <td>${subj.subject_name}</td>
            ${cellsHtml}
        </tr>`;
    });

    const subjectCount = uniqueSubjects.length;
    setText('modal-total', `S1: ${totalS1} | S2: ${totalS2}`);
    setText('modal-avg', subjectCount
        ? `S1: ${(totalS1 / (subjectCount * 6)).toFixed(2)} | S2: ${(totalS2 / (subjectCount * 6)).toFixed(2)}`
        : 'S1: 0.00 | S2: 0.00');
    const modal = document.getElementById('student-modal');
    if (modal) {
        const returnBtn = modal.querySelector('.btn-return');
        trapFocusOpen(modal, returnBtn || modal.querySelector('button'));
        modal.addEventListener('modal-escape', () => trapFocusClose(modal), { once: true });
    }
}

window.closeModal = () => {
    const modal = document.getElementById('student-modal');
    if (modal) trapFocusClose(modal);
};

// SUCCESS MODAL
// MODAL FOCUS MANAGEMENT (accessibility)
// Screen reader and keyboard users need: focus moved into the modal when
// it opens, Escape to close it, and focus restored to whatever triggered
// it once closed — otherwise keyboard focus stays "behind" the modal on
// a now-hidden part of the page, which is disorienting and effectively
// traps nothing while looking like it should.
let lastFocusedBeforeModal = null;

function trapFocusOpen(modalEl, focusTargetEl) {
    lastFocusedBeforeModal = document.activeElement;
    modalEl.style.display = 'flex';
    // Defer focus to the next tick — display:flex needs to take effect
    // first or some browsers won't successfully focus a freshly-visible element.
    setTimeout(() => { if (focusTargetEl) focusTargetEl.focus(); }, 0);

    const onKeydown = (e) => {
        if (e.key === 'Escape') {
            modalEl.dispatchEvent(new CustomEvent('modal-escape'));
        }
        if (e.key === 'Tab') {
            // Simple focus trap: keep Tab/Shift+Tab cycling within the
            // modal's own focusable elements instead of escaping to the
            // page behind it.
            const focusables = modalEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    };
    modalEl.addEventListener('keydown', onKeydown);
    modalEl._trapCleanup = () => modalEl.removeEventListener('keydown', onKeydown);
}

function trapFocusClose(modalEl) {
    modalEl.style.display = 'none';
    if (modalEl._trapCleanup) modalEl._trapCleanup();
    if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
        lastFocusedBeforeModal.focus();
    }
    lastFocusedBeforeModal = null;
}

const showSuccessModal = (message) => {
    const modal = document.getElementById('success-modal');
    if (!modal) return;
    const msgEl = document.getElementById('success-modal-message');
    if (msgEl && message) msgEl.textContent = message;
    const returnBtn = modal.querySelector('button');
    trapFocusOpen(modal, returnBtn);
};

window.closeSuccessModal = () => {
    const modal = document.getElementById('success-modal');
    if (modal) trapFocusClose(modal);
};

// can keep the same "if (await showConfirmModal(...))" shape that native
// confirm() had, just async instead of blocking.
function showAlertModal(message, title = "Notice") {
    const modal = document.getElementById('alert-modal');
    const titleEl = document.getElementById('alert-modal-title');
    const msgEl = document.getElementById('alert-modal-message');
    const okBtn = document.getElementById('alert-modal-ok');

    if (!modal || !okBtn) {
        window.alert(message); // fallback if markup is ever missing
        return;
    }

    titleEl.textContent = title;
    msgEl.textContent = message;
    trapFocusOpen(modal, okBtn);

    const onOk = () => {
        trapFocusClose(modal);
        okBtn.removeEventListener('click', onOk);
        modal.removeEventListener('modal-escape', onOk);
    };
    okBtn.addEventListener('click', onOk);
    modal.addEventListener('modal-escape', onOk);
}

function showConfirmModal(message, title = "Are you sure?") {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-modal-title');
        const msgEl = document.getElementById('confirm-modal-message');
        const okBtn = document.getElementById('confirm-modal-ok');
        const cancelBtn = document.getElementById('confirm-modal-cancel');
        if (!modal || !okBtn || !cancelBtn) {
            // Fallback if the modal markup is ever missing — don't silently
            // block the action, but don't silently allow it either.
            resolve(window.confirm(message));
            return;
        }

        titleEl.textContent = title;
        msgEl.textContent = message;
        trapFocusOpen(modal, cancelBtn);

        const cleanup = (result) => {
            trapFocusClose(modal);
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('modal-escape', onCancel);
            resolve(result);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('modal-escape', onCancel);
    });
}

// Styled replacement for window.prompt() — resolves with the typed text
// (possibly empty string) on Confirm, or null on Cancel/escape, matching
// window.prompt()'s own null-on-cancel convention so call sites don't
// need to change how they check the result.
function showPromptModal(message, title = "Add a note", placeholder = '') {
    return new Promise((resolve) => {
        const modal = document.getElementById('prompt-modal');
        const titleEl = document.getElementById('prompt-modal-title');
        const msgEl = document.getElementById('prompt-modal-message');
        const input = document.getElementById('prompt-modal-input');
        const okBtn = document.getElementById('prompt-modal-ok');
        const cancelBtn = document.getElementById('prompt-modal-cancel');
        if (!modal || !input || !okBtn || !cancelBtn) {
            // Fallback if the modal markup is ever missing.
            resolve(window.prompt(message));
            return;
        }

        titleEl.textContent = title;
        msgEl.textContent = message;
        input.value = '';
        input.placeholder = placeholder;
        trapFocusOpen(modal, input);

        const cleanup = (result) => {
            trapFocusClose(modal);
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('modal-escape', onCancel);
            resolve(result);
        };
        const onOk = () => cleanup(input.value);
        const onCancel = () => cleanup(null);

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('modal-escape', onCancel);
    });
}

// MARK ENTRY — search, submit, bulk upload
window.searchStudent = async () => {
    const id = document.getElementById('search-id').value;
    const display = document.getElementById('student-display');
    const inputs = document.getElementById('mark-inputs');
    
    if (!id) return showAlertModal("Please enter a Student ID");

    try {
        // 1. Fetch student info
        const res = await apiFetch(`${API_BASE}/api/student/${id}`);
        if (!res.ok) throw new Error("Student not found!");
        const student = await res.json();

        // 2. NEW: Check if teacher is assigned to this student's class
        const authRes = await apiFetch(`${API_BASE}/api/teacher/can-access-student?teacher_id=${CURRENT_TEACHER_ID}&student_id=${id}`);
        const { allowed } = await authRes.json();

        if (!allowed) {
            showAlertModal("Access Denied: You are not assigned to this student's class, section, or stream.");
            display.innerHTML = '';
            inputs.style.display = 'none';
            return;
        }

        // 3. Authorized: Proceed to show info
        window.currentStudentStream = student.stream;
        display.innerHTML = `
            <div class="student-info-card" style="padding:10px; background:#e2e8f0; border-radius:8px; margin:10px 0;">
                <strong>Name:</strong> ${[student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' ')}<br>
                <strong>Grade:</strong> ${student.class_level} | <strong>Section:</strong> ${student.section}
            </div>`;
        inputs.style.display = 'block';
        await loadAuthorizedSubjects(student.stream);

    } catch (err) {
        showAlertModal(err.message);
        display.innerHTML = '';
        inputs.style.display = 'none';
    }
};

window.submitIndividualMark = async () => {
    const student_id = document.getElementById('search-id').value;
    const subject_id = document.getElementById('subject-select').value;
    const type = document.getElementById('type-select').value;
    const scoreInput = document.getElementById('score-input');
    const score = parseInt(scoreInput.value);

    if (!subject_id) {
        showAlertModal("Please select a subject before submitting.");
        return;
    }

    if (isNaN(score) || score < 1 || score > 100) {
        showAlertModal("Please enter a valid numeric score between 1 and 100.");
        return;
    }

    try {
        const res = await apiFetch(`${API_BASE}/api/add-mark`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_id, subject_id, type, score })
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.error || ("Server responded with " + res.status));
        }

        const result = await res.json();
        showSuccessModal(result.message || "Mark saved successfully!");
        scoreInput.value = '';

        const modal = document.getElementById('student-modal');
        if (modal && modal.style.display === 'flex') {
            viewStudentProgress(student_id, window.currentStudentStream);
        }

    } catch (err) {
        console.error("Submission error:", err);
        showAlertModal(err.message || "Could not connect to server. Ensure server is running on port 3001.");
    }
};

window.updateFileName = (input, targetId = 'file-name') => {
    const fileName = input.files[0] ? input.files[0].name : "No file chosen";
    const el = document.getElementById(targetId);
    if (el) el.innerText = fileName;
};

window.uploadData = async () => {
    const fileInput = document.getElementById('csv-file');
    if (fileInput.files.length === 0) return showAlertModal("Please select a CSV file first!");

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    try {
        const res = await apiFetch(`${API_BASE}/api/upload-marks`, {
            method: 'POST',
            body: formData // Do NOT set Content-Type when sending FormData
        });
        const result = await res.json();
        if (res.ok) {
            showSuccessModal(result.message || "Marks uploaded successfully!");
        } else {
            showAlertModal(result.error || "Upload failed.");
        }
    } catch (err) {
        console.error("Upload error:", err);
        showAlertModal("Could not connect to server.");
    }
};

// MISC

// 1. Toggle Profile Dropdown
window.toggleDropdown = () => {
    const dropdown = document.getElementById('profile-dropdown');
    const trigger = document.querySelector('.user-profile-trigger');
    if (!dropdown) return;
    const isOpen = dropdown.style.display === 'block';
    dropdown.style.display = isOpen ? 'none' : 'block';
    if (trigger) trigger.setAttribute('aria-expanded', String(!isOpen));
};

// Settings button → navigate to profile page
window.navigateToProfile = () => {
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.page-content').forEach(p => p.style.display = 'none');
    const profilePage = document.getElementById('page-profile');
    if (profilePage) profilePage.style.display = 'block';
    loadTeacherDocumentStatus();
};

// --- Help / Support modal ---
window.openHelpModal = () => {
    const modal = document.getElementById('help-modal');
    if (modal) {
        modal.style.display = 'flex';
        document.getElementById('help-subject').focus();
    }
};
window.closeHelpModal = () => {
    const modal = document.getElementById('help-modal');
    if (modal) modal.style.display = 'none';
};
window.submitHelpRequest = async () => {
    const subject = document.getElementById('help-subject').value.trim();
    const body = document.getElementById('help-body').value.trim();
    if (!subject || !body) { showAlertModal("Please fill in both the subject and message."); return; }
    try {
        const res = await apiFetch(`${API_BASE}/api/contact/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient_role: 'Principal', category: 'General Inquiry', subject, body })
        });
        if (res.ok) {
            closeHelpModal();
            document.getElementById('help-subject').value = '';
            document.getElementById('help-body').value = '';
            showSuccessModal("Support request sent.");
        } else {
            showAlertModal("Could not send support request. Try again.");
        }
    } catch (err) {
        showAlertModal("Could not connect to server.");
    }
};

// --- Notifications ---
async function loadNotifications() {
    try {
        const res = await apiFetch(`${API_BASE}/api/notifications`);
        if (!res.ok) return;
        const data = await res.json();
        renderNotifications(data);
    } catch (err) {
        console.error("Notifications load error:", err);
    }
}

function renderNotifications(data) {
    const badge = document.getElementById('notif-badge');
    const list = document.getElementById('notification-list');
    if (!badge || !list) return;

    if (data.unread_count > 0) {
        badge.textContent = data.unread_count > 99 ? '99+' : data.unread_count;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }

    if (!data.items || data.items.length === 0) {
        list.innerHTML = '<p class="notif-empty">No new notifications</p>';
        return;
    }

    list.innerHTML = data.items.map(item => `
        <div class="notif-item" onclick="openNotificationThread(${item.thread_id})">
            <strong>Reply from ${item.from}</strong>
            ${item.subject} &mdash; ${item.reply_count} new message${item.reply_count !== 1 ? 's' : ''}
        </div>`).join('');
}

window.toggleNotificationPanel = () => {
    const panel = document.getElementById('notification-panel');
    const btn = document.querySelector('.notification-btn');
    if (!panel) return;
    const isOpen = panel.style.display === 'block';
    panel.style.display = isOpen ? 'none' : 'block';
    if (btn) btn.setAttribute('aria-expanded', String(!isOpen));
};

window.openNotificationThread = (thread_id) => {
    document.getElementById('notification-panel').style.display = 'none';
    // Navigate to Contact page and open the thread
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.page-content').forEach(p => p.style.display = 'none');
    const contactPage = document.getElementById('page-contact');
    if (contactPage) contactPage.style.display = 'block';
    apiFetch(`${API_BASE}/api/contact/thread/${thread_id}/mark-read`, { method: 'POST' }).catch(() => {});
    loadContactThreads().then(() => openContactThread(thread_id));
    loadNotifications();
};

window.markAllNotificationsRead = async () => {
    const list = document.getElementById('notification-list');
    if (!list) return;
    const items = list.querySelectorAll('.notif-item');
    // Extract thread IDs from onclick attributes and mark each read
    const promises = [];
    items.forEach(item => {
        const match = item.getAttribute('onclick').match(/\d+/);
        if (match) promises.push(apiFetch(`${API_BASE}/api/contact/thread/${match[0]}/mark-read`, { method: 'POST' }));
    });
    await Promise.all(promises);
    loadNotifications();
};

window.onclick = (event) => {
    // Close student modal on backdrop click
    const modal = document.getElementById('student-modal');
    if (modal && event.target === modal) trapFocusClose(modal);

    // Close profile dropdown when clicking outside
    if (!event.target.closest('.user-profile-trigger')) {
        const dropdown = document.getElementById('profile-dropdown');
        if (dropdown) {
            dropdown.style.display = "none";
            const trigger = document.querySelector('.user-profile-trigger');
            if (trigger) trigger.setAttribute('aria-expanded', 'false');
        }
    }

    // Close notification panel when clicking outside
    if (!event.target.closest('.notification-wrapper')) {
        const panel = document.getElementById('notification-panel');
        const btn = document.querySelector('.notification-btn');
        if (panel && panel.style.display === 'block') {
            panel.style.display = 'none';
            if (btn) btn.setAttribute('aria-expanded', 'false');
        }
    }
};

// 3. Logout Logic
const logoutBtns = document.querySelectorAll('.logout-btn');
logoutBtns.forEach(logoutBtn => {
    logoutBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
            await apiFetch(`${API_BASE}/api/logout`, { method: 'POST' });
        } catch (err) {
            console.error("Logout request failed:", err);
            // Still redirect even if the request fails — staying on a page
            // that thinks it's logged out but has a stale cookie is worse
            // than just sending them to login again.
        }
        window.location.href = '/login.html';
    });
});

window.toggleTheme = () => document.body.classList.toggle('dark-theme');

async function loadAuthorizedSubjects(stream) {
    const select = document.getElementById('subject-select');
    if (!select) {
        console.error("Dropdown element #subject-select not found in the DOM!");
        return;
    }

    try {
        const url = `${API_BASE}/api/teacher/eligible-subjects?teacher_id=${CURRENT_TEACHER_ID}&stream=${encodeURIComponent(stream)}`;
        console.log("Fetching subjects from:", url);
        
        const res = await apiFetch(url);
        const subjects = await res.json();
        
        console.log("Subjects received:", subjects);

        select.innerHTML = '<option value="">Select a Subject</option>';
        subjects.forEach(sub => {
            const option = document.createElement('option');
            option.value = sub.subject_id;
            option.textContent = sub.subject_name;
            select.appendChild(option);
        });
    } catch (err) {
        console.error("Error loading eligible subjects:", err);
    }
}

// SECTION GRADE SHEET — bulk marks entry table (Upload Marks page).
// Lets a teacher pick one of their sections + a subject, then enter
// scores for every assessment type for every student in that section at
// once, instead of one student/subject/type at a time.
const GRADESHEET_ASSESSMENT_TYPES = ['individual_assignment_1', 'individual_assignment_2', 'group_assignment', 'quiz', 'midterm', 'final'];
let gradeSheetSections = [];   // [{class_level, section, stream}]
let gradeSheetStudents = [];   // students currently loaded for the selected section

// Populates the section dropdown from the teacher's own assignments —
// same source as My Sections elsewhere, so it naturally covers a teacher
// who teaches multiple classes/sections.
async function loadGradeSheetSections() {
    const select = document.getElementById('gradesheet-section');
    if (!select) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/my-sections`);
        gradeSheetSections = res.ok ? await res.json() : [];

        select.innerHTML = '<option value="">Select section…</option>' +
            gradeSheetSections.map((s, i) =>
                `<option value="${i}">${escapeHtml(formatGradeSectionStream(s.class_level, s.section, s.stream))}</option>`
            ).join('');
    } catch (err) {
        console.error("loadGradeSheetSections error:", err);
    }
}

window.onGradeSheetSectionChange = async () => {
    const select = document.getElementById('gradesheet-section');
    const subjectSelect = document.getElementById('gradesheet-subject');
    const container = document.getElementById('gradesheet-container');
    const actions = document.getElementById('gradesheet-actions');

    subjectSelect.innerHTML = '<option value="">Select subject…</option>';
    container.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Select a section and subject above to begin.</p>';
    actions.style.display = 'none';

    const idx = select.value;
    if (idx === '') return;
    const { stream } = gradeSheetSections[idx];

    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/eligible-subjects?teacher_id=${CURRENT_TEACHER_ID}&stream=${encodeURIComponent(stream)}`);
        const subjects = res.ok ? await res.json() : [];
        subjectSelect.innerHTML = '<option value="">Select subject…</option>' +
            subjects.map(s => `<option value="${s.subject_id}">${escapeHtml(s.subject_name)}</option>`).join('');
    } catch (err) {
        console.error("Error loading subjects for grade sheet:", err);
    }
};

window.onGradeSheetSubjectChange = async () => {
    const sectionSelect = document.getElementById('gradesheet-section');
    const subjectSelect = document.getElementById('gradesheet-subject');
    const container = document.getElementById('gradesheet-container');
    const actions = document.getElementById('gradesheet-actions');

    const idx = sectionSelect.value;
    const subjectId = subjectSelect.value;
    if (idx === '' || !subjectId) {
        actions.style.display = 'none';
        return;
    }

    const { class_level, section, stream } = gradeSheetSections[idx];
    container.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">Loading students…</p>';

    try {
        const res = await apiFetch(`${API_BASE}/api/teacher/my-students?class_level=${encodeURIComponent(class_level)}&section=${encodeURIComponent(section)}&stream=${encodeURIComponent(stream)}`);
        gradeSheetStudents = res.ok ? await res.json() : [];
        renderGradeSheetTable(gradeSheetStudents);
        actions.style.display = gradeSheetStudents.length ? 'flex' : 'none';
        const status = document.getElementById('gradesheet-status');
        if (status) status.textContent = '';
    } catch (err) {
        console.error("Error loading students for grade sheet:", err);
        container.innerHTML = '<p style="color:#b91c1c; font-size:0.85rem;">Could not load students for this section.</p>';
    }
};

function renderGradeSheetTable(students) {
    const container = document.getElementById('gradesheet-container');
    if (!container) return;

    if (!students.length) {
        container.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No students found in this section.</p>';
        return;
    }

    const headerCells = GRADESHEET_ASSESSMENT_TYPES.map(type => `<th>${escapeHtml(assessmentTypeLabel(type))}</th>`).join('');

    const rows = students.map(s => {
        const fullName = [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ');
        const cells = GRADESHEET_ASSESSMENT_TYPES.map(type => `
            <td>
                <label for="gs-${s.student_id}-${type}" class="sr-only">${escapeHtml(assessmentTypeLabel(type))} score for ${escapeHtml(fullName)}</label>
                <input type="number" min="0" max="100" class="gradesheet-input"
                       id="gs-${s.student_id}-${type}"
                       data-student-id="${s.student_id}"
                       data-type="${type}"
                       oninput="this.classList.add('gradesheet-input-dirty'); this.classList.remove('gradesheet-input-saved','gradesheet-input-error');">
            </td>`).join('');
        return `
            <tr data-search-text="${escapeHtml((fullName + ' ' + s.student_id).toLowerCase())}">
                <td><strong>${escapeHtml(s.student_id)}</strong><br><span style="color:#64748b;">${escapeHtml(fullName)}</span></td>
                ${cells}
            </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="gradesheet-table-wrap">
            <table class="gradesheet-table">
                <thead><tr><th>Student</th>${headerCells}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

window.applyGradeSheetSearch = () => {
    const term = (document.getElementById('gradesheet-search')?.value || '').trim().toLowerCase();
    document.querySelectorAll('#gradesheet-container tbody tr').forEach(row => {
        const text = row.getAttribute('data-search-text') || '';
        row.style.display = !term || text.includes(term) ? '' : 'none';
    });
};

// Saves every cell that has a value typed into it (marked "dirty" by the
// oninput handler above) — untouched cells are left alone entirely, so
// re-saving the same sheet twice doesn't create duplicate mark rows for
// cells nobody actually changed.
window.saveGradeSheet = async () => {
    const subjectId = document.getElementById('gradesheet-subject')?.value;
    const status = document.getElementById('gradesheet-status');
    if (!subjectId) { showAlertModal("Please select a subject first."); return; }

    const dirtyInputs = Array.from(document.querySelectorAll('#gradesheet-container .gradesheet-input-dirty'))
        .filter(input => input.value !== '');

    if (dirtyInputs.length === 0) {
        showAlertModal("No new scores entered to save.");
        return;
    }

    if (status) status.textContent = `Saving ${dirtyInputs.length} score(s)…`;

    const results = await Promise.allSettled(dirtyInputs.map(async (input) => {
        const student_id = input.dataset.studentId;
        const type = input.dataset.type;
        const score = parseInt(input.value, 10);

        if (isNaN(score) || score < 0 || score > 100) {
            throw new Error('Score must be between 0 and 100');
        }

        const res = await apiFetch(`${API_BASE}/api/add-mark`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_id, subject_id: subjectId, type, score })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to save');
        return input;
    }));

    let successCount = 0;
    let firstError = null;
    results.forEach((result, i) => {
        const input = dirtyInputs[i];
        if (result.status === 'fulfilled') {
            successCount++;
            input.classList.remove('gradesheet-input-dirty', 'gradesheet-input-error');
            input.classList.add('gradesheet-input-saved');
        } else {
            input.classList.add('gradesheet-input-error');
            input.classList.remove('gradesheet-input-dirty');
            if (!firstError) firstError = result.reason?.message || 'Failed to save';
        }
    });

    const failCount = dirtyInputs.length - successCount;
    if (status) {
        status.textContent = failCount === 0
            ? `Saved ${successCount} score(s).`
            : `Saved ${successCount} score(s), ${failCount} failed.`;
    }
    if (failCount > 0) {
        showAlertModal(`${failCount} score(s) could not be saved. ${firstError ? 'First error: ' + firstError : ''} Cells with a red border were not saved — fix and try again.`);
    } else {
        showSuccessModal(`Saved ${successCount} score(s) successfully!`);
    }
};