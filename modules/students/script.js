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
    document.querySelector('a[data-page="idcard"]').addEventListener('click', loadIDCard);
    document.querySelector('a[data-page="certificate"]').addEventListener('click', loadCertificate);

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
// Programmatic equivalent of clicking a sidebar link — used by the
// settings button and the notification panel's "See all" link, so they
// stay in sync with whatever setupNavigation wires up for real clicks.
window.navigateTo = (target) => {
    const navLinks = document.querySelectorAll('.nav-link:not(.nav-external)');
    const pages = document.querySelectorAll('.page-content');
    navLinks.forEach(l => l.classList.remove('active'));
    const matchingLink = document.querySelector(`.nav-link[data-page="${target}"]`);
    if (matchingLink) matchingLink.classList.add('active');
    pages.forEach(p => p.style.display = 'none');
    const page = document.getElementById(`page-${target}`);
    if (page) page.style.display = 'block';
    closeSidebar();
    closeNotificationPanel();
};

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
        profileDataCache = data;

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

// ---- CERTIFICATE ----
async function loadCertificate() {
    const output = document.getElementById('certificate-output');
    if (!output) return;
    output.innerHTML = '<p class="muted">Loading…</p>';
    try {
        const res = await apiFetch('/api/student/my-certificate');
        if (!res.ok) throw new Error();
        const data = await res.json();
        renderCertificate(data, output);
    } catch (err) {
        console.error('Certificate load error:', err);
        output.innerHTML = '<p class="muted">Could not load certificate data.</p>';
    }
}

function renderCertificate(data, container) {
    if (!data.terms || !data.terms.length) {
        container.innerHTML = `<p class="muted">${data.message || 'No pushed marks history yet — check back once your teachers have submitted grades.'}</p>`;
        return;
    }

    const termCards = data.terms.map(t => `
        <div class="widget" style="margin-bottom:14px;">
            <h3>Grade ${t.class_level} — ${t.term} <span class="muted" style="font-weight:400; font-size:0.8rem;">(${t.section}, ${t.stream})</span></h3>
            ${t.synced
                ? `<span class="badge badge-returned">Synced</span>`
                : `<span class="badge badge-issued">Pending sync</span>`}
            <div class="marks-rows" style="margin-top:10px;">
                ${t.subjects.map(s => `
                    <div class="marks-row">
                        <span class="marks-type">${s.subject_name}</span>
                        <span class="marks-score ${scoreClass(s.total_score)}">${Number(s.total_score).toFixed(1)}%</span>
                    </div>`).join('')}
            </div>
            <p style="margin-top:8px; font-weight:700;">Term total: ${t.term_total.toFixed(1)}%</p>
        </div>`).join('');

    const downloadSection = data.ready
        ? `<button type="button" class="btn-cancel" style="width:auto;" onclick="window.print()">Print / Download Certificate</button>`
        : `<p class="muted">Your certificate isn't downloadable yet — every term needs to be fully pushed by your subject teachers and synced by your homeroom teacher to Academic VP first. ${data.terms.filter(t => !t.synced).length} term(s) still pending.</p>`;

    container.innerHTML = termCards + downloadSection;
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '—';
}

// ---- ID CARD ----
let profileDataCache = null;

async function loadIDCard() {
    const output = document.getElementById('idcard-output');
    if (!output) return;
    output.innerHTML = '<p class="muted">Loading…</p>';
    try {
        // Reuse the same /api/student/me data the Profile page uses,
        // rather than a second round-trip, if we already have it cached.
        const data = profileDataCache || await (await apiFetch('/api/student/me')).json();
        renderIDCard(data, output);
    } catch (err) {
        console.error('ID card load error:', err);
        output.innerHTML = '<p class="muted">Could not load your ID card.</p>';
    }
}

function renderIDCard(data, container) {
    const full = [data.first_name, data.middle_name, data.last_name].filter(Boolean).join(' ');
    const initials = full.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

    const issued = data.created_at ? new Date(data.created_at) : new Date();
    const expires = new Date(issued);
    expires.setFullYear(expires.getFullYear() + 2);
    const isExpired = expires < new Date();
    const fmt = d => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

    // Ethiopian administrative address: woreda, zone, region — there's no
    // street-address field in this schema, so this is what "school address"
    // means here.
    const addressParts = [data.woreda, data.zone, data.region].filter(Boolean);
    const address = addressParts.length ? addressParts.join(', ') : 'Address not set for this school';

    container.innerHTML = `
        <div class="id-card-flip-wrap">
            <div class="id-card id-card-front">
                <div class="id-card-header">
                    <img src="/assets/images/Logo.png" alt="School logo" class="id-card-logo" onerror="this.style.display='none'">
                    <div class="id-card-header-text">
                        <div class="id-card-school-name">${data.school_name || 'School'}</div>
                        <div class="id-card-subtitle">Student Identity Card</div>
                    </div>
                </div>
                <div class="id-card-body">
                    <div class="id-card-photo">${initials || '?'}</div>
                    <div class="id-card-fields">
                        <div class="id-card-name">${full}</div>
                        <div><span class="id-label">Student ID</span><span>${data.student_id}</span></div>
                        <div><span class="id-label">Class</span><span>Grade ${data.class_level} - ${data.section}</span></div>
                        <div><span class="id-label">Stream</span><span>${data.stream || '—'}</span></div>
                        <div><span class="id-label">Contact</span><span>${data.phone_number || '—'}</span></div>
                        ${data.moe_school_code ? `<div><span class="id-label">School Code</span><span>${data.moe_school_code}</span></div>` : ''}
                    </div>
                </div>
                <div class="id-card-footer">
                    <div class="id-card-signature">
                        <img src="/assets/images/principal-signature.png" alt="Principal's signature" onerror="this.style.display='none'">
                        <div class="id-card-signature-line">Principal</div>
                    </div>
                    <div class="id-card-validity">
                        <span>Issued: ${fmt(issued)}</span>
                        <strong class="${isExpired ? 'id-card-expired' : ''}">Valid until: ${fmt(expires)}</strong>
                    </div>
                </div>
            </div>
            <div class="id-card id-card-back" style="display:none;">
                <div class="id-card-back-body">
                    <h4>Terms &amp; Conditions</h4>
                    <ul class="id-card-terms">
                        <li>This card is the property of ${data.school_name || 'the school'} and must be carried at all times on school premises.</li>
                        <li>This card is non-transferable. Report loss or theft to the school office immediately.</li>
                        <li>Misuse of this card may result in disciplinary action.</li>
                        <li>This card is valid only through the expiry date shown on the front.</li>
                    </ul>
                    <div class="id-card-back-footer">
                        <p class="id-card-return-note">If found, please return to the school address below.</p>
                        <div id="idcard-qr" class="id-card-qr"></div>
                    </div>
                </div>
                <div class="id-card-address-bar">${data.school_name || 'School'} — ${address}</div>
            </div>
        </div>`;

    // Rendered after the innerHTML above so #idcard-qr actually exists in
    // the DOM yet. Encodes the signed token, not the bare student ID.
    const qrTarget = document.getElementById('idcard-qr');
    if (qrTarget && data.qr_payload && window.QRCode) {
        qrTarget.innerHTML = '';
        new QRCode(qrTarget, {
            text: data.qr_payload,
            width: 72,
            height: 72,
            colorDark: '#1e293b',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
    }
}

window.flipIDCard = () => {
    const front = document.querySelector('.id-card-front');
    const back = document.querySelector('.id-card-back');
    if (!front || !back) return;
    const showingFront = front.style.display !== 'none';
    front.style.display = showingFront ? 'none' : 'block';
    back.style.display = showingFront ? 'block' : 'none';
};

// ---- ACCOUNT SECURITY ----
window.updatePassword = async () => {
    const currentPass = document.getElementById('curr-pass').value;
    const newPass = document.getElementById('new-pass').value;
    const confirmPass = document.getElementById('confirm-pass').value;
    const msg = document.getElementById('password-message');

    const showMsg = (text, isError) => {
        if (!msg) return;
        msg.textContent = text;
        msg.style.color = isError ? '#dc2626' : '#16a34a';
    };

    if (!currentPass || !newPass || !confirmPass) {
        showMsg('Please fill in all three fields.', true);
        return;
    }
    if (newPass !== confirmPass) {
        showMsg('New password and confirmation do not match.', true);
        return;
    }
    if (newPass.length < 4) {
        showMsg('New password must be at least 4 characters.', true);
        return;
    }

    try {
        const res = await apiFetch('/api/student/update-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPass, newPass })
        });
        const data = await res.json();
        if (res.ok) {
            showMsg('Password updated successfully.', false);
            document.getElementById('curr-pass').value = '';
            document.getElementById('new-pass').value = '';
            document.getElementById('confirm-pass').value = '';
        } else {
            showMsg(data.error || 'Could not update password.', true);
        }
    } catch (err) {
        showMsg('Could not connect to server.', true);
    }
};

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

const ASSESSMENT_TYPE_LABELS = { individual_assignment_1: 'Assignment 1', individual_assignment_2: 'Assignment 2',
    group_assignment: 'Group Assignment', quiz: 'Quiz', midterm: 'Midterm', final: 'Final' };
const ALL_ASSESSMENT_TYPES = Object.keys(ASSESSMENT_TYPE_LABELS);

// Groups raw mark rows into subject -> term -> total/completeness, since a
// subject's total must never mix marks from two different terms, and an
// "average" is only meaningful once every expected assessment type for
// that subject/term has actually been recorded.
function computeSubjectTermTotals(marks) {
    const bySubject = {};
    marks.forEach(m => {
        if (!bySubject[m.subject_name]) bySubject[m.subject_name] = {};
        const bucket = bySubject[m.subject_name];
        if (!bucket[m.term]) bucket[m.term] = [];
        bucket[m.term].push(m);
    });

    const results = [];
    Object.entries(bySubject).forEach(([subject, byTerm]) => {
        Object.entries(byTerm).forEach(([term, rows]) => {
            const total = rows.reduce((s, r) => s + (Number(r.score) || 0), 0);
            const presentTypes = new Set(rows.map(r => r.type));
            const isComplete = ALL_ASSESSMENT_TYPES.every(t => presentTypes.has(t));
            results.push({ subject, term, rows, total, presentTypes, isComplete });
        });
    });
    return results;
}

function renderMarks(marks) {
    const output = document.getElementById('marks-output');
    if (!output) return;
    if (!marks.length) { output.innerHTML = '<p class="muted">No marks recorded yet.</p>'; return; }

    const grouped = computeSubjectTermTotals(marks);
    const bySubject = {};
    grouped.forEach(g => {
        if (!bySubject[g.subject]) bySubject[g.subject] = [];
        bySubject[g.subject].push(g);
    });

    output.innerHTML = Object.entries(bySubject).map(([subject, terms]) => `
        <div class="marks-subject-card">
            <div class="marks-subject-header"><strong>${subject}</strong></div>
            ${terms.map(g => {
                const totalLabel = g.isComplete
                    ? `Final: ${g.total.toFixed(1)}%`
                    : `Total so far: ${g.total.toFixed(1)}% (${g.presentTypes.size}/${ALL_ASSESSMENT_TYPES.length} assessments)`;
                return `
                <div class="marks-term-group">
                    <div class="marks-term-header">
                        <span class="muted">${g.term}</span>
                        <span class="marks-avg">${totalLabel}</span>
                    </div>
                    <div class="marks-rows">
                        ${g.rows.map(r => `
                            <div class="marks-row">
                                <span class="marks-type">${ASSESSMENT_TYPE_LABELS[r.type] || r.type}</span>
                                <span class="marks-score ${scoreClass(r.score)}">${r.score}%</span>
                            </div>`).join('')}
                    </div>
                </div>`;
            }).join('')}
        </div>`).join('');
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
        if (!res.ok) {
            if (output) output.innerHTML = '<p class="muted">Could not load notifications.</p>';
            return;
        }
        // The API returns { unread_count, items }, not a flat array.
        const data = await res.json();
        notifData = data.items || [];
        updateNotifBadge(data.unread_count);
        if (output) renderNotifications(notifData, output);
        updateDashboardNotifs(notifData);
    } catch (err) {
        console.error('Notifications error:', err);
        if (output) output.innerHTML = '<p class="muted">Could not load notifications.</p>';
    }
}

function updateNotifBadge(unreadCount) {
    const sidebarBadge = document.getElementById('notif-nav-badge');
    if (sidebarBadge) {
        sidebarBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
        sidebarBadge.style.display = unreadCount > 0 ? 'inline-flex' : 'none';
    }
    const topbarBadge = document.getElementById('notif-badge');
    if (topbarBadge) {
        topbarBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
        topbarBadge.style.display = unreadCount > 0 ? 'inline-block' : 'none';
    }
    renderNotificationPanel();
}

function renderNotifications(notifs, container) {
    if (!notifs.length) { container.innerHTML = '<p class="muted">No notifications yet.</p>'; return; }
    container.innerHTML = notifs.map(n => `
        <div class="notif-card ${n.is_read ? '' : 'notif-unread'}" onclick="markRead(${n.notif_id}, this)">
            <div class="notif-card-header">
                <strong>${n.assessment_type.replace(/_/g, ' ')}</strong>
                ${n.is_read ? '' : '<span class="notif-dot" aria-label="Unread"></span>'}
            </div>
            <p class="notif-body">${n.message}</p>
            <p class="notif-meta muted">${new Date(n.sent_at).toLocaleDateString()}</p>
        </div>`).join('');
}

// ---- TOP-BAR NOTIFICATION PANEL (bell dropdown) ----
// Shows a compact preview of the same data the Notifications page renders
// in full — reuses notifData rather than fetching separately.
function renderNotificationPanel() {
    const list = document.getElementById('notification-panel-list');
    if (!list) return;
    if (!notifData.length) {
        list.innerHTML = '<p class="notif-empty">No new notifications</p>';
        return;
    }
    list.innerHTML = notifData.slice(0, 5).map(n => `
        <div class="notif-item" onclick="markRead(${n.notif_id}, this); navigateTo('notifications')">
            <strong>${n.assessment_type.replace(/_/g, ' ')}</strong><br>
            ${n.message.substring(0, 60)}${n.message.length > 60 ? '…' : ''}
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

function closeNotificationPanel() {
    const panel = document.getElementById('notification-panel');
    const btn = document.querySelector('.notification-btn');
    if (panel) panel.style.display = 'none';
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.notification-wrapper')) closeNotificationPanel();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNotificationPanel();
});

// ---- HELP MODAL ----
// Opens the user's email client with the message pre-filled, rather than
// filing an in-system support ticket — the existing contact/thread system
// is built specifically around teacher_id ownership, and repurposing it
// for students would mislabel who actually sent each message.
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
window.submitHelpRequest = () => {
    const subject = document.getElementById('help-subject').value.trim();
    const body = document.getElementById('help-body').value.trim();
    if (!subject || !body) {
        alert('Please fill in both the subject and message.');
        return;
    }
    const studentLine = CURRENT_STUDENT_ID ? `Student ID: ${CURRENT_STUDENT_ID}\n\n` : '';
    const mailto = `mailto:support@example.edu?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(studentLine + body)}`;
    window.location.href = mailto;
    closeHelpModal();
    document.getElementById('help-subject').value = '';
    document.getElementById('help-body').value = '';
};

window.markRead = async (notif_id, el) => {
    el.classList.remove('notif-unread');
    el.querySelector('.notif-dot')?.remove();
    await apiFetch('/api/student/mark-notification-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notif_id })
    }).catch(() => {});
    const idx = notifData.findIndex(n => n.notif_id === notif_id);
    if (idx !== -1) notifData[idx].is_read = 1;
    const stillUnread = notifData.filter(n => !n.is_read).length;
    updateNotifBadge(stillUnread);
};

// ---- DASHBOARD ----
async function loadDashboard() {
    await Promise.all([loadMarks(), loadTextbooks(), loadAttendanceStreak()]);
    updateDashboardSummary();
    updateDashboardTextbooks();
}

async function loadAttendanceStreak() {
    const el = document.getElementById('dashboard-attendance');
    if (!el) return;
    try {
        const res = await apiFetch('/api/student/my-attendance-streak');
        if (!res.ok) throw new Error();
        const data = await res.json();
        const dots = Array.from({ length: Math.min(data.streak, 10) }, () => '🔥').join('');
        el.innerHTML = `
            <div class="summary-stat">
                <span class="summary-num">${data.streak}</span>
                <span class="muted">Day streak${data.streak > 0 ? ' ' + dots : ''}</span>
            </div>
            <p class="muted" style="margin-top:6px; font-size:0.8rem;">
                ${data.present_today ? 'Checked in today ✅' : 'Not checked in yet today'}
            </p>`;
    } catch {
        el.innerHTML = '<p class="muted">Could not load attendance.</p>';
    }
}

function updateDashboardSummary() {
    const el = document.getElementById('dashboard-summary');
    if (!el || !allMarks.length) {
        if (el) el.innerHTML = '<p class="muted">No marks recorded yet.</p>';
        return;
    }
    const grouped = computeSubjectTermTotals(allMarks);
    const completed = grouped.filter(g => g.isComplete);
    const subjects = new Set(allMarks.map(m => m.subject_name)).size;

    const avgBlock = completed.length
        ? `<div class="summary-stat"><span class="summary-num">${(completed.reduce((s, g) => s + g.total, 0) / completed.length).toFixed(1)}%</span><span class="muted">Average (completed subjects)</span></div>`
        : `<div class="summary-stat"><span class="summary-num">—</span><span class="muted">No subject fully graded yet</span></div>`;

    el.innerHTML = `
        ${avgBlock}
        <div class="summary-stat"><span class="summary-num">${allMarks.length}</span><span class="muted">Assessments recorded</span></div>
        <div class="summary-stat"><span class="summary-num">${subjects}</span><span class="muted">Subjects</span></div>`;
}

function updateDashboardNotifs(notifs) {
    const el = document.getElementById('dashboard-notifs');
    if (!el) return;
    const recent = notifs.slice(0, 3);
    if (!recent.length) { el.innerHTML = '<p class="muted">No notifications.</p>'; return; }
    el.innerHTML = recent.map(n => `
        <div class="notif-card ${n.is_read ? '' : 'notif-unread'}" style="margin-bottom:8px;">
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