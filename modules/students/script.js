const API_BASE = '';
let CURRENT_STUDENT_ID = null;

// ---- AUTH ----
async function apiFetch(url, opts = {}) {
    return fetch(url, { credentials: 'include', ...opts });
}

async function checkAuth() {
    try {
        const res = await apiFetch('/api/me');
        if (!res.ok) { window.location.href = '/login.html'; return false; }
        const data = await res.json();
        if (data.role !== 'students') { window.location.href = '/login.html'; return false; }
        CURRENT_STUDENT_ID = data.user_id;
        const titleEl = document.getElementById('page-title-text');
        const logoEl  = document.getElementById('nav-school-name');
        if (data.school_name) {
            if (titleEl) titleEl.textContent = data.school_name;
            if (logoEl)  logoEl.textContent  = data.school_name;
        }
        return true;
    } catch {
        window.location.href = '/login.html';
        return false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const ok = await checkAuth();
    if (!ok) return;
    setupNavigation();
    setupSidebarToggle();
    await Promise.all([loadProfile(), loadNotifications()]);
    loadDashboard();
    document.querySelector('a[data-page="notifications"]').addEventListener('click', loadNotifications);
    document.querySelector('a[data-page="marks"]').addEventListener('click', loadMarks);
    document.querySelector('a[data-page="textbooks"]').addEventListener('click', loadTextbooks);

    const signOut = document.querySelector('a[href="/login.html"]');
    if (signOut) {
        signOut.addEventListener('click', async (e) => {
            e.preventDefault();
            await apiFetch('/api/logout', { method: 'POST' });
            window.location.href = '/login.html';
        });
    }
});

// ---- NAVIGATION ----
function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link:not(.nav-external)');
    const pages    = document.querySelectorAll('.page-content');
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const clicked = e.currentTarget;
            navLinks.forEach(l => l.classList.remove('active'));
            clicked.classList.add('active');
            pages.forEach(p => p.style.display = 'none');
            const target = clicked.getAttribute('data-page');
            const page = document.getElementById(`page-${target}`);
            if (page) page.style.display = 'block';
            closeSidebar();
        });
    });
}

function setupSidebarToggle() {
    const sidebar  = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const overlay  = document.getElementById('sidebar-overlay');
    if (!sidebar || !toggleBtn || !overlay) return;
    toggleBtn.addEventListener('click', () => {
        const open = sidebar.classList.toggle('sidebar-open');
        overlay.classList.toggle('sidebar-overlay-visible', open);
        toggleBtn.setAttribute('aria-expanded', String(open));
    });
    overlay.addEventListener('click', closeSidebar);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const btn     = document.getElementById('sidebar-toggle');
    if (!sidebar || !sidebar.classList.contains('sidebar-open')) return;
    sidebar.classList.remove('sidebar-open');
    if (overlay) overlay.classList.remove('sidebar-overlay-visible');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

window.addEventListener('resize', () => { if (window.innerWidth > 900) closeSidebar(); });

// ---- PROFILE ----
async function loadProfile() {
    try {
        const res  = await apiFetch('/api/student/me');
        if (!res.ok) return;
        const data = await res.json();

        const full = [data.first_name, data.middle_name, data.last_name].filter(Boolean).join(' ');
        const initials = full.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

        const greetEl  = document.getElementById('nav-greeting');
        const initEl   = document.getElementById('profile-initials');
        if (greetEl)   greetEl.textContent = `Hi, ${data.first_name}!`;
        if (initEl)    initEl.textContent  = initials;

        setText('p-name',    full);
        setText('p-id',      data.student_id);
        setText('p-sex',     data.sex);
        setText('p-status',  data.status);
        setText('p-grade',   `Grade ${data.class_level}`);
        setText('p-section', data.section);
        setText('p-stream',  data.stream);
        setText('p-school',  data.school_name);
        setText('p-lms',     data.lms_username);
        setText('p-email',   data.email_address);
        setText('p-pc',      data.assigned_computer);
    } catch (err) {
        console.error('Profile load error:', err);
    }
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '—';
}

// ---- MARKS ----
let allMarks = [];

async function loadMarks() {
    const output = document.getElementById('marks-output');
    if (!output) return;
    output.innerHTML = '<p class="muted">Loading…</p>';
    try {
        const res = await apiFetch('/api/student/my-marks');
        if (!res.ok) throw new Error();
        allMarks = await res.json();
        populateTermFilter(allMarks);
        renderMarks(allMarks);
    } catch {
        output.innerHTML = '<p class="muted">Could not load marks.</p>';
    }
}

function populateTermFilter(marks) {
    const sel = document.getElementById('marks-term-filter');
    if (!sel) return;
    const terms = [...new Set(marks.map(m => m.term).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All Terms</option>' +
        terms.map(t => `<option value="${t}">${t}</option>`).join('');
    sel.onchange = () => {
        const filtered = sel.value ? allMarks.filter(m => m.term === sel.value) : allMarks;
        renderMarks(filtered);
    };
}

function renderMarks(marks) {
    const output = document.getElementById('marks-output');
    if (!output) return;
    if (!marks.length) { output.innerHTML = '<p class="muted">No marks recorded yet.</p>'; return; }

    // Group by subject
    const bySubject = {};
    marks.forEach(m => {
        if (!bySubject[m.subject_name]) bySubject[m.subject_name] = [];
        bySubject[m.subject_name].push(m);
    });

    const typeLabel = { individual_assignment_1: 'Assignment 1', individual_assignment_2: 'Assignment 2',
        group_assignment: 'Group Assignment', quiz: 'Quiz', midterm: 'Midterm', final: 'Final' };

    output.innerHTML = Object.entries(bySubject).map(([subject, rows]) => {
        const total = rows.reduce((s, r) => s + (Number(r.score) || 0), 0);
        const avg   = (total / rows.length).toFixed(1);
        return `
        <div class="marks-subject-card">
            <div class="marks-subject-header">
                <strong>${subject}</strong>
                <span class="marks-avg">Avg: ${avg}%</span>
            </div>
            <div class="marks-rows">
                ${rows.map(r => `
                    <div class="marks-row">
                        <span class="marks-type">${typeLabel[r.type] || r.type}</span>
                        <span class="marks-term muted">${r.term}</span>
                        <span class="marks-score ${scoreClass(r.score)}">${r.score}%</span>
                    </div>`).join('')}
            </div>
        </div>`;
    }).join('');
}

function scoreClass(score) {
    if (score >= 80) return 'score-high';
    if (score >= 50) return 'score-mid';
    return 'score-low';
}

// ---- TEXTBOOKS ----
async function loadTextbooks() {
    const output = document.getElementById('textbooks-output');
    if (!output) return;
    output.innerHTML = '<p class="muted">Loading…</p>';
    try {
        const res = await apiFetch('/api/student/my-textbooks');
        if (!res.ok) throw new Error();
        const books = await res.json();
        renderTextbooks(books, output);
    } catch {
        output.innerHTML = '<p class="muted">Could not load textbook status.</p>';
    }
}

function renderTextbooks(books, container) {
    if (!books.length) { container.innerHTML = '<p class="muted">No textbooks issued this school year.</p>'; return; }
    const statusBadge = {
        issued:   '<span class="badge badge-issued">Issued</span>',
        returned: '<span class="badge badge-returned">Returned</span>',
        lost:     '<span class="badge badge-lost">Lost</span>'
    };
    container.innerHTML = `
        <div class="table-container">
            <table>
                <thead><tr><th>Subject</th><th>Status</th><th>Issued</th><th>Resolved</th></tr></thead>
                <tbody>
                    ${books.map(b => `<tr>
                        <td>${b.subject_name}</td>
                        <td>${statusBadge[b.status] || b.status}</td>
                        <td>${b.issued_at ? new Date(b.issued_at).toLocaleDateString() : '—'}</td>
                        <td>${b.returned_at ? new Date(b.returned_at).toLocaleDateString() :
                              b.lost_at    ? new Date(b.lost_at).toLocaleDateString() : '—'}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>`;
}

// ---- NOTIFICATIONS ----
let notifData = [];

async function loadNotifications() {
    const output = document.getElementById('notifications-output');
    try {
        const res = await apiFetch('/api/student/my-notifications');
        if (!res.ok) return;
        notifData = await res.json();
        updateNotifBadge(notifData);
        if (output) renderNotifications(notifData, output);
        updateDashboardNotifs(notifData);
    } catch (err) {
        console.error('Notifications error:', err);
    }
}

function updateNotifBadge(notifs) {
    const badge = document.getElementById('notif-nav-badge');
    const unread = notifs.filter(n => !n.read_at).length;
    if (badge) {
        badge.textContent = unread > 9 ? '9+' : unread;
        badge.style.display = unread > 0 ? 'inline-flex' : 'none';
    }
}

function renderNotifications(notifs, container) {
    if (!notifs.length) { container.innerHTML = '<p class="muted">No notifications yet.</p>'; return; }
    container.innerHTML = notifs.map(n => `
        <div class="notif-card ${n.read_at ? '' : 'notif-unread'}" onclick="markRead(${n.notif_id}, this)">
            <div class="notif-card-header">
                <strong>${n.assessment_type.replace(/_/g, ' ')}</strong>
                ${n.read_at ? '' : '<span class="notif-dot" aria-label="Unread"></span>'}
            </div>
            <p class="notif-body">${n.message}</p>
            <p class="notif-meta muted">From: ${n.sent_by_name || 'Your teacher'} &middot; ${new Date(n.sent_at).toLocaleDateString()}</p>
        </div>`).join('');
}

window.markRead = async (notif_id, el) => {
    el.classList.remove('notif-unread');
    el.querySelector('.notif-dot')?.remove();
    await apiFetch('/api/student/mark-notification-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notif_id })
    }).catch(() => {});
    const idx = notifData.findIndex(n => n.notif_id === notif_id);
    if (idx !== -1) notifData[idx].read_at = new Date().toISOString();
    updateNotifBadge(notifData);
};

// ---- DASHBOARD ----
async function loadDashboard() {
    await Promise.all([loadMarks(), loadTextbooks()]);
    updateDashboardSummary();
    updateDashboardTextbooks();
}

function updateDashboardSummary() {
    const el = document.getElementById('dashboard-summary');
    if (!el || !allMarks.length) {
        if (el) el.innerHTML = '<p class="muted">No marks recorded yet.</p>';
        return;
    }
    const avg = (allMarks.reduce((s, m) => s + Number(m.score), 0) / allMarks.length).toFixed(1);
    const subjects = [...new Set(allMarks.map(m => m.subject_name))].length;
    el.innerHTML = `
        <div class="summary-stat"><span class="summary-num">${avg}%</span><span class="muted">Overall average</span></div>
        <div class="summary-stat"><span class="summary-num">${allMarks.length}</span><span class="muted">Assessments recorded</span></div>
        <div class="summary-stat"><span class="summary-num">${subjects}</span><span class="muted">Subjects</span></div>`;
}

function updateDashboardNotifs(notifs) {
    const el = document.getElementById('dashboard-notifs');
    if (!el) return;
    const recent = notifs.slice(0, 3);
    if (!recent.length) { el.innerHTML = '<p class="muted">No notifications.</p>'; return; }
    el.innerHTML = recent.map(n => `
        <div class="notif-card ${n.read_at ? '' : 'notif-unread'}" style="margin-bottom:8px;">
            <strong style="font-size:0.85rem;">${n.assessment_type.replace(/_/g, ' ')}</strong>
            <p class="muted" style="font-size:0.82rem; margin-top:2px;">${n.message.substring(0, 80)}${n.message.length > 80 ? '…' : ''}</p>
        </div>`).join('');
}

function updateDashboardTextbooks() {
    const el = document.getElementById('dashboard-textbooks');
    if (!el) return;
    const output = document.getElementById('textbooks-output');
    if (output && output.children.length) {
        el.innerHTML = output.innerHTML;
    }
}