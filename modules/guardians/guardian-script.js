const API_BASE = '';
let CURRENT_GUARDIAN_ID = null;
let CURRENT_CHILD = null; // the child object currently open on page-child

// ---- AUTH ----
async function apiFetch(url, opts = {}) {
    return fetch(url, { credentials: 'include', ...opts });
}

// Free-text fields that come from another role's input (a teacher's
// conduct-warning message, etc.) are never trusted as HTML — always
// escaped before going into innerHTML.
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = (val === null || val === undefined || val === '') ? '—' : val;
}

function showToast(message, type = 'success', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="toast-icon">${type === 'error' ? '⚠️' : '✅'}</span><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-leaving');
        setTimeout(() => toast.remove(), 220);
    }, duration);
}

async function checkAuth() {
    try {
        const res = await apiFetch('/api/me');
        if (!res.ok) { window.location.href = '/login.html'; return false; }
        const data = await res.json();
        if (data.role !== 'guardians') { window.location.href = '/login.html'; return false; }
        CURRENT_GUARDIAN_ID = data.user_id;
        return data.must_change_password ? 'must_change_password' : true;
    } catch {
        window.location.href = '/login.html';
        return false;
    }
}

function wireStaticEventListeners() {
    const on = (id, event, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener(event, handler);
    };

    on('sidebar-signout-btn', 'click', () => openSignOutModal());
    on('signout-modal-cancel-btn', 'click', () => closeSignOutModal());
    on('signout-modal-confirm-btn', 'click', () => signOutNow());
    on('help-btn-open', 'click', () => openHelpModal());
    on('help-modal-cancel-btn', 'click', () => closeHelpModal());
    on('help-modal-send-btn', 'click', () => submitHelpRequest());
    on('account-btn', 'click', () => toggleAccountMenu());
    on('account-profile-settings-btn', 'click', () => { navigateTo('profile'); closeAccountMenu(); });
    document.querySelectorAll('.lang-switch-btn').forEach(btn => {
        btn.addEventListener('click', () => setLang(btn.dataset.lang));
    });

    on('avatar-upload-btn', 'click', () => {
        const input = document.getElementById('avatar-upload-input');
        if (input) input.click();
    });
    on('avatar-upload-input', 'change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) uploadAvatar(file);
        e.target.value = '';
    });

    on('update-password-btn', 'click', () => updatePassword());
    on('child-back-btn', 'click', () => navigateTo('dashboard'));
    on('child-tab-btn-overview', 'click', () => switchChildTab('overview'));
    on('child-tab-btn-marks', 'click', () => switchChildTab('marks'));
    on('child-tab-btn-attendance', 'click', () => switchChildTab('attendance'));
    on('child-tab-btn-conduct', 'click', () => switchChildTab('conduct'));

    // Delegated: "View Details" buttons are re-rendered every time the
    // children list loads, so this is wired once on the container
    // rather than re-attached per card.
    const childrenList = document.getElementById('children-list');
    if (childrenList) {
        childrenList.addEventListener('click', (e) => {
            const btn = e.target.closest('.guardian-view-child-btn');
            if (!btn) return;
            openChild(btn.dataset.studentId);
        });
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof applyTranslations === 'function') applyTranslations();

    const authResult = await checkAuth();
    if (!authResult) return;

    setupSidebarToggle();
    wireStaticEventListeners();
    const mcpBtn = document.getElementById('mcp-submit-btn');
    if (mcpBtn) mcpBtn.addEventListener('click', submitForcedPasswordChange);

    if (authResult === 'must_change_password') {
        const overlay = document.getElementById('must-change-password-overlay');
        if (overlay) overlay.style.display = 'flex';
        return;
    }

    setupNavigation();
    await loadProfile();
    loadChildren();
});

window.onSisLangChange = () => {
    loadProfile();
    loadChildren();
    if (CURRENT_CHILD) openChild(CURRENT_CHILD.student_id);
};

// ---- SIDEBAR / NAV (identical mechanics to the student portal) ----
function setupSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const overlay = document.getElementById('sidebar-overlay');
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
    const btn = document.getElementById('sidebar-toggle');
    if (!sidebar || !sidebar.classList.contains('sidebar-open')) return;
    sidebar.classList.remove('sidebar-open');
    if (overlay) overlay.classList.remove('sidebar-overlay-visible');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}
window.addEventListener('resize', () => { if (window.innerWidth > 900) closeSidebar(); });

function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link:not(.nav-external)');
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(e.currentTarget.getAttribute('data-page'));
        });
    });
}

// The child-detail page (page-child) is reached from a card, not a
// sidebar link, so it's deliberately left out of the nav-link/active
// toggling below — only the two real nav pages fight over "active".
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
};

window.openSignOutModal = () => {
    const modal = document.getElementById('signout-modal');
    if (modal) modal.style.display = 'flex';
};
window.closeSignOutModal = () => {
    const modal = document.getElementById('signout-modal');
    if (modal) modal.style.display = 'none';
};
window.signOutNow = async () => {
    await apiFetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
};

window.toggleAccountMenu = () => {
    const menu = document.getElementById('account-menu');
    const btn = document.querySelector('.account-btn');
    if (!menu) return;
    const isOpen = menu.style.display === 'block';
    menu.style.display = isOpen ? 'none' : 'block';
    if (btn) btn.setAttribute('aria-expanded', String(!isOpen));
};
window.closeAccountMenu = () => {
    const menu = document.getElementById('account-menu');
    const btn = document.querySelector('.account-btn');
    if (menu) menu.style.display = 'none';
    if (btn) btn.setAttribute('aria-expanded', 'false');
};
document.addEventListener('click', (e) => {
    if (!e.target.closest('.account-wrapper')) closeAccountMenu();
});

// ---- HELP MODAL ----
window.openHelpModal = () => {
    const modal = document.getElementById('help-modal');
    if (modal) { modal.style.display = 'flex'; document.getElementById('help-subject').focus(); }
};
window.closeHelpModal = () => {
    const modal = document.getElementById('help-modal');
    if (modal) modal.style.display = 'none';
};
window.submitHelpRequest = () => {
    const subject = document.getElementById('help-subject').value.trim();
    const body = document.getElementById('help-body').value.trim();
    if (!subject || !body) { alert(t('help_fill_both')); return; }
    const guardianLine = CURRENT_GUARDIAN_ID ? `Guardian Login ID: ${CURRENT_GUARDIAN_ID}\n\n` : '';
    const mailto = `mailto:support@example.edu?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(guardianLine + body)}`;
    window.location.href = mailto;
    closeHelpModal();
    document.getElementById('help-subject').value = '';
    document.getElementById('help-body').value = '';
};

// ---- FORCED PASSWORD CHANGE (first login on the default "1234") ----
// Same shape/reasoning as the student portal's submitForcedPinChange:
// a full reload on success re-runs the whole init path against the
// freshly-issued (unblocked) session cookie.
window.submitForcedPasswordChange = async () => {
    const currentPass = document.getElementById('mcp-curr-pass').value;
    const newPass = document.getElementById('mcp-new-pass').value;
    const confirmPass = document.getElementById('mcp-confirm-pass').value;
    const msg = document.getElementById('mcp-message');

    const showMsg = (text, isError) => {
        if (!msg) return;
        msg.textContent = text;
        msg.style.color = isError ? '#dc2626' : '#16a34a';
    };

    if (!currentPass || !newPass || !confirmPass) { showMsg(t('profile_fill_all_fields'), true); return; }
    if (newPass !== confirmPass) { showMsg(t('profile_passwords_no_match'), true); return; }
    if (newPass.length < 4) { showMsg(t('profile_password_too_short'), true); return; }

    try {
        const res = await apiFetch('/api/guardian/update-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPass, newPass })
        });
        const data = await res.json();
        if (res.ok) {
            window.location.reload();
        } else {
            showMsg(data.error || t('profile_could_not_update_password'), true);
        }
    } catch {
        showMsg(t('could_not_connect'), true);
    }
};

// ---- PROFILE PAGE (Change Password from the settled-in Profile tab) ----
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

    if (!currentPass || !newPass || !confirmPass) { showMsg(t('profile_fill_all_fields'), true); return; }
    if (newPass !== confirmPass) { showMsg(t('profile_passwords_no_match'), true); return; }
    if (newPass.length < 4) { showMsg(t('profile_password_too_short'), true); return; }

    try {
        const res = await apiFetch('/api/guardian/update-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPass, newPass })
        });
        const data = await res.json();
        if (res.ok) {
            showMsg(t('profile_password_updated'), false);
            document.getElementById('curr-pass').value = '';
            document.getElementById('new-pass').value = '';
            document.getElementById('confirm-pass').value = '';
        } else {
            showMsg(data.error || t('profile_could_not_update_password'), true);
        }
    } catch {
        showMsg(t('could_not_connect'), true);
    }
};

async function loadProfile() {
    try {
        const res = await apiFetch('/api/guardian/me');
        if (!res.ok) return;
        const data = await res.json();

        const initials = (data.full_name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

        // Just the guardian's name here — "Guardian" is already shown
        // right below it (nav-role), so repeating the word here would
        // show it twice at once.
        const greetEl = document.getElementById('nav-greeting');
        if (greetEl) greetEl.textContent = data.full_name || t('greeting_guardian_default');

        const initEl = document.getElementById('profile-initials');
        const avatarEl = document.getElementById('nav-avatar');
        if (data.avatar_url) {
            if (initEl) initEl.innerHTML = `<img src="${escapeHtml(data.avatar_url)}" alt="">`;
            if (avatarEl) avatarEl.innerHTML = `<img src="${escapeHtml(data.avatar_url)}" alt="">`;
        } else {
            if (initEl) initEl.textContent = initials;
            if (avatarEl) avatarEl.textContent = initials;
        }

        const zoneLogoEl = document.getElementById('nav-zone-logo');
        if (zoneLogoEl) {
            if (data.zone_logo_url) {
                zoneLogoEl.src = data.zone_logo_url;
                zoneLogoEl.style.display = 'block';
            } else {
                zoneLogoEl.style.display = 'none';
            }
        }
        const schoolLogoEl = document.getElementById('nav-school-logo');
        if (schoolLogoEl) {
            if (data.school_logo_url) {
                schoolLogoEl.src = data.school_logo_url;
                schoolLogoEl.style.display = 'block';
            } else {
                schoolLogoEl.style.display = 'none';
            }
        }

        setText('p-login-id', data.parent_code);
        setText('p-name', data.full_name);
        setText('p-phone', data.phone_number);
        setText('p-fayda', data.fayda_number);
    } catch (err) {
        console.error('Guardian profile load error:', err);
    }
}

// ---- AVATAR UPLOAD ----
async function uploadAvatar(file) {
    if (!file) return;
    const formData = new FormData();
    formData.append('avatar', file);
    try {
        const res = await apiFetch('/api/guardian/upload-avatar', {
            method: 'POST',
            body: formData,
        });
        const data = await res.json();
        if (res.ok && data.avatar_url) {
            const initEl = document.getElementById('profile-initials');
            const avatarEl = document.getElementById('nav-avatar');
            if (initEl) initEl.innerHTML = `<img src="${escapeHtml(data.avatar_url)}" alt="">`;
            if (avatarEl) avatarEl.innerHTML = `<img src="${escapeHtml(data.avatar_url)}" alt="">`;
            showToast(t('guardian_photo_updated'), 'success');
        } else {
            showToast(data.error || t('guardian_photo_upload_failed'), 'error');
        }
    } catch {
        showToast(t('could_not_connect'), 'error');
    }
}

// ---- MULTI-SCHOOL OVERVIEW (children list) ----
let CHILDREN_CACHE = [];

async function loadChildren() {
    const el = document.getElementById('children-list');
    if (!el) return;
    el.innerHTML = `<p class="muted">${t('loading')}</p>`;
    try {
        const res = await apiFetch('/api/guardian/children');
        if (!res.ok) throw new Error();
        CHILDREN_CACHE = await res.json();
        renderChildren(CHILDREN_CACHE);
    } catch {
        el.innerHTML = `<p class="muted">${t('could_not_connect')}</p>`;
    }
}

function renderChildren(children) {
    const el = document.getElementById('children-list');
    if (!el) return;
    if (!children.length) {
        el.innerHTML = `<p class="muted">${t('guardian_no_children')}</p>`;
        return;
    }
    el.innerHTML = children.map(c => `
        <div class="widget">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:10px;">
                <div class="avatar-initials" style="width:44px; height:44px; font-size:0.95rem;" aria-hidden="true">
                    ${c.profile_photo_url ? `<img src="${escapeHtml(c.profile_photo_url)}" alt="">` : escapeHtml((c.full_name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase())}
                </div>
                <div>
                    <h3 style="margin:0;">${escapeHtml(c.full_name)}</h3>
                    <span class="muted">${t('guardian_child_class', { level: c.class_level, section: c.section })}</span>
                </div>
            </div>
            <p><strong>${t('guardian_child_school')}:</strong> ${escapeHtml(c.school_name)}</p>
            <p><strong>${t('guardian_child_status')}:</strong> ${escapeHtml(c.status)}</p>
            <button type="button" class="btn-primary guardian-view-child-btn" data-student-id="${escapeHtml(c.student_id)}" data-i18n="guardian_view_details">
                ${t('guardian_view_details')}
            </button>
        </div>
    `).join('');
}

// ---- CHILD DETAIL (Overview / Marks / Attendance / Conduct tabs) ----
function openChild(studentId) {
    CURRENT_CHILD = CHILDREN_CACHE.find(c => String(c.student_id) === String(studentId)) || { student_id: studentId };
    navigateTo('child');
    document.getElementById('page-child').style.display = 'block';
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

    setText('child-detail-name', CURRENT_CHILD.full_name || studentId);
    const subtitle = document.getElementById('child-detail-subtitle');
    if (subtitle) {
        subtitle.textContent = CURRENT_CHILD.school_name
            ? t('guardian_child_class', { level: CURRENT_CHILD.class_level, section: CURRENT_CHILD.section }) + ' · ' + CURRENT_CHILD.school_name
            : '';
    }

    switchChildTab('overview');
    loadChildOverview(studentId);
    loadChildMarks(studentId);
    loadChildAttendance(studentId);
    loadChildConduct(studentId);
}

window.switchChildTab = (tab) => {
    const tabs = ['overview', 'marks', 'attendance', 'conduct'];
    tabs.forEach(name => {
        const pane = document.getElementById(`child-tab-${name}`);
        const btn = document.getElementById(`child-tab-btn-${name}`);
        if (pane) pane.style.display = name === tab ? 'block' : 'none';
        if (btn) btn.className = name === tab ? 'btn-primary' : 'btn-cancel';
    });
};

async function loadChildOverview(studentId) {
    const el = document.getElementById('child-overview-output');
    if (!el) return;
    el.innerHTML = `<p class="muted">${t('loading')}</p>`;
    try {
        const res = await apiFetch(`/api/guardian/children/${encodeURIComponent(studentId)}/overview`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        el.innerHTML = `
            <div class="widget">
                <h3 data-i18n="guardian_tab_attendance">Attendance</h3>
                <div class="summary-stat">
                    <span class="summary-num">${data.attendance_streak}</span>
                    <span class="muted">${t('guardian_attendance_streak_days', { n: data.attendance_streak })}</span>
                </div>
                <p class="muted" style="margin-top:6px;">${data.present_today ? t('guardian_today_present') : t('guardian_today_absent')}</p>
            </div>
            <div class="widget">
                <h3 data-i18n="guardian_tab_conduct">Conduct</h3>
                <div class="summary-stat">
                    <span class="summary-num">${escapeHtml(data.conduct_grade ?? '—')}</span>
                    <span class="muted">${t('guardian_conduct_grade')}</span>
                </div>
                <p class="muted" style="margin-top:6px;">${t('guardian_conduct_warnings_count', { n: data.conduct_warnings })}</p>
            </div>
            <div class="widget">
                <h3>${t('guardian_child_status')}</h3>
                <p><strong>${t('guardian_marks_term')}:</strong> ${escapeHtml(data.term)}</p>
                <p><strong>${t('guardian_child_status')}:</strong> ${escapeHtml(data.term_status)}</p>
                ${data.term_status_reason ? `<p class="muted">${escapeHtml(data.term_status_reason)}</p>` : ''}
            </div>`;
    } catch {
        el.innerHTML = `<p class="muted">${t('could_not_connect')}</p>`;
    }
}

async function loadChildMarks(studentId) {
    const el = document.getElementById('child-marks-output');
    if (!el) return;
    el.innerHTML = `<p class="muted">${t('loading')}</p>`;
    try {
        const res = await apiFetch(`/api/guardian/children/${encodeURIComponent(studentId)}/marks`);
        if (!res.ok) throw new Error();
        const marks = await res.json();
        if (!marks.length) {
            el.innerHTML = `<p class="muted">${t('guardian_marks_none')}</p>`;
            return;
        }
        el.innerHTML = `
            <table style="width:100%; border-collapse:collapse;">
                <thead>
                    <tr style="text-align:left; border-bottom:2px solid var(--border, #e2e8f0);">
                        <th style="padding:8px;">${t('guardian_marks_term')}</th>
                        <th style="padding:8px;">${t('guardian_marks_subject')}</th>
                        <th style="padding:8px;">${t('guardian_marks_type')}</th>
                        <th style="padding:8px;">${t('guardian_marks_score')}</th>
                    </tr>
                </thead>
                <tbody>
                    ${marks.map(m => `
                        <tr style="border-bottom:1px solid var(--border, #eef1f5);">
                            <td style="padding:8px;">${escapeHtml(m.term)}</td>
                            <td style="padding:8px;">${escapeHtml(m.subject_name)}</td>
                            <td style="padding:8px;">${escapeHtml(m.type)}</td>
                            <td style="padding:8px;">${escapeHtml(String(m.score))}</td>
                        </tr>`).join('')}
                </tbody>
            </table>`;
    } catch {
        el.innerHTML = `<p class="muted">${t('could_not_connect')}</p>`;
    }
}

async function loadChildAttendance(studentId) {
    const el = document.getElementById('child-attendance-output');
    if (!el) return;
    el.innerHTML = `<p class="muted">${t('loading')}</p>`;
    try {
        const res = await apiFetch(`/api/guardian/children/${encodeURIComponent(studentId)}/attendance`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        renderChildAttendance(data);
    } catch {
        el.innerHTML = `<p class="muted">${t('could_not_connect')}</p>`;
    }
}

// Same GitHub-style heatmap approach as the student portal's own
// attendance calendar widget, just for a fixed recent window instead
// of a paged one (see /api/guardian/children/:id/attendance).
function renderChildAttendance(data) {
    const el = document.getElementById('child-attendance-output');
    if (!el || !data.days.length) return;

    const statusColor = { present: '#16a34a', absent: '#dc2626', excused: '#3b82f6', weekend: '#d1d5db', holiday: '#eab308', future: '#f3f4f6', not_started: '#f3f4f6', semester_closed: '#e5e7eb' };
    const statusLabel = {
        present: t('guardian_attendance_present'),
        absent: t('guardian_attendance_absent'),
        excused: t('guardian_attendance_excused'),
        weekend: t('guardian_attendance_weekend'),
        holiday: t('guardian_attendance_holiday'),
        future: t('guardian_attendance_future'),
        not_started: t('guardian_attendance_not_started'),
        semester_closed: t('guardian_attendance_semester_closed'),
    };

    const firstDay = new Date(data.days[0].date + 'T00:00:00');
    const startOffset = firstDay.getDay();
    const weekCount = Math.ceil((startOffset + data.days.length) / 7);

    const cells = data.days.map((d, i) => {
        const cellIndex = startOffset + i;
        const col = Math.floor(cellIndex / 7) + 1;
        const row = (cellIndex % 7) + 1;
        const dt = new Date(d.date + 'T00:00:00');
        let title = '';
        if (d.status !== 'future' && d.status !== 'not_started') {
            const greg = dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            const label = d.status === 'holiday' && d.holiday_name ? `${statusLabel.holiday} — ${d.holiday_name}` : statusLabel[d.status];
            title = `${greg}\n${label}`;
        }
        return `<div title="${escapeHtml(title)}" style="grid-column:${col}; grid-row:${row}; width:15px; height:15px; border-radius:3px; background:${statusColor[d.status]};"></div>`;
    }).join('');

    el.innerHTML = `
        <div style="overflow-x:auto;">
            <div style="display:grid; grid-template-columns:repeat(${weekCount}, 15px); grid-template-rows:repeat(7, 15px); gap:3px; min-width:${weekCount * 18}px;">
                ${cells}
            </div>
        </div>
        <div style="display:flex; gap:14px; margin-top:12px; font-size:0.78rem; flex-wrap:wrap;">
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#16a34a;margin-right:4px;"></span>${statusLabel.present}</span>
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#dc2626;margin-right:4px;"></span>${statusLabel.absent}</span>
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#3b82f6;margin-right:4px;"></span>${statusLabel.excused}</span>
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#eab308;margin-right:4px;"></span>${statusLabel.holiday}</span>
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#d1d5db;margin-right:4px;"></span>${statusLabel.weekend}</span>
        </div>`;
}

async function loadChildConduct(studentId) {
    const el = document.getElementById('child-conduct-output');
    if (!el) return;
    el.innerHTML = `<p class="muted">${t('loading')}</p>`;
    try {
        const res = await apiFetch(`/api/guardian/children/${encodeURIComponent(studentId)}/conduct`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        const feed = data.warnings.length
            ? data.warnings.map(w => `
                <div class="notif-card" style="margin-bottom:8px;">
                    <p class="muted" style="font-size:0.78rem; margin-bottom:4px;">${new Date(w.sent_at).toLocaleString()}</p>
                    <p style="margin:0;">${escapeHtml(w.message)}</p>
                </div>`).join('')
            : `<p class="muted">${t('guardian_conduct_no_warnings')}</p>`;

        el.innerHTML = `
            <div class="summary-stat" style="margin-bottom:16px;">
                <span class="summary-num">${escapeHtml(data.term_conduct_grade ?? '—')}</span>
                <span class="muted">${t('guardian_conduct_grade')} · ${t('guardian_conduct_warnings_count', { n: data.term_warning_count })}</span>
            </div>
            <h3 data-i18n="guardian_conduct_feed_heading" style="font-size:1rem; margin-bottom:10px;">${t('guardian_conduct_feed_heading')}</h3>
            ${feed}`;
    } catch {
        el.innerHTML = `<p class="muted">${t('could_not_connect')}</p>`;
    }
}
