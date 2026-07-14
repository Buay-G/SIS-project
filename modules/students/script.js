const API_BASE = '';
let CURRENT_STUDENT_ID = null;

// ---- AUTH ----
async function apiFetch(url, opts = {}) {
    return fetch(url, { credentials: 'include', ...opts });
}

// Free-text fields that come from another role's input (e.g. a teacher's
// notification message) are never trusted as HTML — always escaped before
// going into innerHTML, so neither a malicious payload nor an innocent
// "<" in ordinary text (e.g. "score < 50") can break rendering or execute.
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
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
        const displayName = data.school_name
            ? (data.moe_school_code ? `${data.school_name} · MOE ${data.moe_school_code}` : data.school_name)
            : null;
        if (displayName) {
            if (titleEl) titleEl.textContent = displayName;
            if (logoEl)  logoEl.textContent  = displayName;
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
    document.querySelector('a[data-page="absence"]').addEventListener('click', loadAbsenceHistory);
    // School Hub is now a standalone external page (hub.html) — no in-app
    // click handler needed; the nav link is a plain target="_blank" href.
});

window.signOutNow = async () => {
    await apiFetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
};

// i18n.js's setLang() calls this after switching languages and re-running
// applyTranslations() on static text — this re-renders everything that
// was built as HTML strings with t() baked in (marks, textbooks, ID
// card, certificate, notifications), since a data-i18n attribute alone
// can't re-translate those.
window.onSisLangChange = () => {
    loadProfile();
    loadNotifications();
    loadDashboard();
    loadMarks();
    loadTextbooks();
    loadIDCard();
    loadCertificate();
    loadAbsenceHistory();
};

// ---- ACCOUNT DROPDOWN (Profile Settings / Sign Out) ----
window.toggleAccountMenu = () => {
    const menu = document.getElementById('account-menu');
    const btn = document.querySelector('.account-btn');
    if (!menu) return;
    const isOpen = menu.style.display === 'block';
    menu.style.display = isOpen ? 'none' : 'block';
    if (btn) btn.setAttribute('aria-expanded', String(!isOpen));
    closeNotificationPanel(); // only one dropdown open at a time
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
        const avatarEl = document.getElementById('nav-avatar');
        if (greetEl)   greetEl.textContent = t('greeting', { name: data.first_name });

        // Profile photo, if set, replaces the initials placeholder in both
        // the header avatar and the Profile page's Identity card.
        if (initEl) {
            initEl.innerHTML = data.profile_photo_url
                ? `<img src="${data.profile_photo_url}" alt="Profile photo">`
                : initials;
        }
        if (avatarEl) {
            avatarEl.innerHTML = data.profile_photo_url
                ? `<img src="${data.profile_photo_url}" alt="">`
                : initials;
        }

        const idPhotoPreview = document.getElementById('id-photo-preview');
        if (idPhotoPreview) {
            idPhotoPreview.innerHTML = data.id_photo_url
                ? `<img src="${data.id_photo_url}" alt="ID photo">`
                : t('profile_no_photo');
        }

        setText('p-name',    full);
        setText('p-id',      data.student_id);
        setText('p-sex',     data.sex);
        setText('p-status',  data.status);
        setText('p-grade',   t('profile_grade_value', { level: data.class_level }));
        setText('p-section', data.section);
        setText('p-stream',  data.stream);
        setText('p-school',  data.school_name);
        setText('p-lms',     data.lms_username);
        setText('p-email',   data.email_address);
        setText('p-pc',      data.assigned_computer);

        loadIDPhotoRequestStatus();
    } catch (err) {
        console.error('Profile load error:', err);
    }
}

// ---- ID PHOTO CHANGE REQUEST STATUS ----
// Shared by the Profile page's request box and re-run after a switch of
// language, so the pending/approved/rejected banner always reflects the
// latest request even without a full page reload.
async function loadIDPhotoRequestStatus() {
    const box = document.getElementById('id-photo-request-status');
    if (!box) return;
    try {
        const res = await apiFetch('/api/student/id-photo-request-status');
        if (!res.ok) throw new Error();
        const data = await res.json();
        renderRequestStatusBox(box, data, {
            pending: t('profile_id_photo_pending'),
            approved: t('profile_id_photo_approved'),
            rejected: t('profile_id_photo_rejected', { reason: data.rejection_reason || '—' })
        });
    } catch (err) {
        console.error('ID photo request status error:', err);
        box.style.display = 'none';
    }
}

// Shared renderer for both the ID-photo and certificate request status
// boxes — same three states (pending/approved/rejected), same styling,
// just different copy per call site.
function renderRequestStatusBox(box, data, messages) {
    if (!data || !data.status || data.status === 'none') {
        box.style.display = 'none';
        return;
    }
    box.style.display = 'block';
    box.className = `request-status-box request-status-${data.status}`;
    box.textContent = messages[data.status] || '';
}

// ---- PHOTO UPLOADS ----
async function uploadPhoto(inputEl, endpoint, messageElId) {
    const file = inputEl.files[0];
    const msgEl = document.getElementById(messageElId);
    if (!file) return;

    const showMsg = (text, isError) => {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.style.color = isError ? '#dc2626' : '#16a34a';
    };

    const formData = new FormData();
    formData.append('photo', file);

    showMsg(t('profile_uploading'), false);
    try {
        const res = await apiFetch(endpoint, { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
            showMsg(t('profile_photo_uploaded'), false);
            await loadProfile(); // refresh previews with the new URL
        } else {
            showMsg(data.error || t('profile_upload_failed'), true);
        }
    } catch (err) {
        showMsg(t('could_not_connect'), true);
    } finally {
        inputEl.value = ''; // allow re-selecting the same file later
    }
}

window.uploadProfilePhoto = (inputEl) => uploadPhoto(inputEl, '/api/student/upload-profile-photo', 'profile-photo-message');

// ID photo is request-based, not a direct upload — the file still goes
// to the same endpoint (it needs somewhere to live either way), but the
// server files it as a pending request rather than setting it as the
// official photo. Doesn't touch the actual id-photo-preview image, since
// nothing official changed yet — just shows the pending banner.
window.uploadIDPhoto = async (inputEl) => {
    const file = inputEl.files[0];
    const msgEl = document.getElementById('id-photo-message');
    if (!file) return;

    const showMsg = (text, isError) => {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.style.color = isError ? '#dc2626' : '#16a34a';
    };

    const formData = new FormData();
    formData.append('photo', file);

    showMsg(t('profile_uploading'), false);
    try {
        const res = await apiFetch('/api/student/upload-id-photo', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
            showMsg('', false);
            showToast(t('profile_id_photo_request_submitted'), 'success');
            await loadIDPhotoRequestStatus();
        } else {
            showMsg(data.error || t('profile_upload_failed'), true);
        }
    } catch (err) {
        showMsg(t('could_not_connect'), true);
    } finally {
        inputEl.value = '';
    }
};

// ---- CERTIFICATE ----
async function loadCertificate() {
    const output = document.getElementById('certificate-output');
    if (!output) return;
    output.innerHTML = `<p class="muted">${t('loading')}</p>`;
    try {
        const res = await apiFetch('/api/student/my-certificate');
        if (!res.ok) throw new Error();
        const data = await res.json();
        renderCertificate(data, output);
        await loadCertificateRequestStatus(data.ready);
    } catch (err) {
        console.error('Certificate load error:', err);
        output.innerHTML = `<p class="muted">${t('certificate_could_not_load')}</p>`;
    }
}

async function loadCertificateRequestStatus(ready) {
    const box = document.getElementById('certificate-request-status');
    const requestBtn = document.getElementById('certificate-request-btn');
    const downloadBtn = document.getElementById('certificate-download-btn');
    if (!box || !requestBtn || !downloadBtn) return;

    requestBtn.style.display = 'none';
    downloadBtn.style.display = 'none';

    try {
        const res = await apiFetch('/api/student/certificate-request-status');
        if (!res.ok) throw new Error();
        const data = await res.json();

        renderRequestStatusBox(box, data, {
            pending: t('certificate_request_pending'),
            approved: t('certificate_request_approved'),
            rejected: t('certificate_request_rejected', { reason: data.rejection_reason || '—' })
        });

        if (data.status === 'approved') {
            downloadBtn.style.display = 'inline-block';
        } else if (data.status === 'pending') {
            // nothing to click — waiting on homeroom teacher, box above
            // already says so
        } else if (ready) {
            // no request yet (or a previous one was rejected) and the
            // underlying term data is fully synced — student can request
            requestBtn.style.display = 'inline-block';
        } else if (data.status === 'none') {
            // Neither button applies yet, and there's no status box to
            // explain why (that only shows for pending/approved/rejected)
            // — show a plain note instead of leaving an unexplained gap
            // that looks like the buttons are just missing/broken.
            box.style.display = 'block';
            box.className = 'request-status-box request-status-pending';
            box.textContent = t('certificate_not_yet_requestable');
        }
    } catch (err) {
        console.error('Certificate request status error:', err);
        box.style.display = 'none';
    }
}

window.requestCertificate = async () => {
    const requestBtn = document.getElementById('certificate-request-btn');
    if (requestBtn) requestBtn.disabled = true;
    try {
        const res = await apiFetch('/api/student/request-certificate', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || t('certificate_request_failed'), 'error');
            return;
        }
        showToast(t('certificate_request_pending'), 'success');
        await loadCertificateRequestStatus(true);
    } catch (err) {
        showToast(t('certificate_request_failed'), 'error');
    } finally {
        if (requestBtn) requestBtn.disabled = false;
    }
};

// Navigates to the actual generated PDF (server sets Content-Disposition:
// attachment, so this triggers a real download) rather than printing
// whatever happens to be in the on-screen preview, which is just the
// term-summary widget, not the official certificate layout.
window.downloadCertificate = () => {
    window.location.href = '/api/student/certificate.pdf';
};

function renderCertificate(data, container) {
    if (!data.terms || !data.terms.length) {
        container.innerHTML = `<p class="muted">${data.message || t('certificate_none')}</p>`;
        return;
    }

    const termCards = data.terms.map(term => `
        <div class="widget" style="margin-bottom:14px;">
            <h3>${t('profile_grade_value', { level: term.class_level })} — ${term.term} <span class="muted" style="font-weight:400; font-size:0.8rem;">(${term.section}, ${term.stream})</span></h3>
            ${term.synced
                ? `<span class="badge badge-returned">${t('certificate_synced')}</span>`
                : `<span class="badge badge-issued">${t('certificate_pending_sync')}</span>`}
            <div class="marks-rows" style="margin-top:10px;">
                ${term.subjects.map(s => `
                    <div class="marks-row">
                        <span class="marks-type">${s.subject_name}</span>
                        <span class="marks-score ${scoreClass(s.total_score)}">${Number(s.total_score).toFixed(1)}%</span>
                    </div>`).join('')}
            </div>
            <p style="margin-top:8px; font-weight:700;">${t('certificate_term_total', { pct: term.term_total.toFixed(1) })}</p>
        </div>`).join('');

    const notReadyNote = data.ready ? '' : `<p class="muted">${t('certificate_not_ready', { count: data.terms.filter(term => !term.synced).length })}</p>`;

    container.innerHTML = termCards + notReadyNote;
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '—';
}

// ---- TOAST NOTIFICATIONS ----
// For one-off "this just happened" feedback (request sent, etc.) —
// distinct from the persistent status boxes, which stay visible to show
// ongoing pending/approved/rejected state.
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

// ---- ID CARD ----
let profileDataCache = null;

async function loadIDCard() {
    const output = document.getElementById('idcard-output');
    if (!output) return;
    output.innerHTML = `<p class="muted">${t('loading')}</p>`;
    try {
        // Reuse the same /api/student/me data the Profile page uses,
        // rather than a second round-trip, if we already have it cached.
        const data = profileDataCache || await (await apiFetch('/api/student/me')).json();
        renderIDCard(data, output);
    } catch (err) {
        console.error('ID card load error:', err);
        output.innerHTML = `<p class="muted">${t('idcard_could_not_load')}</p>`;
    }
}

function renderIDCard(data, container) {
    const full = [data.first_name, data.middle_name, data.last_name].filter(Boolean).join(' ');
    const initials = full.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

    const issued = data.created_at ? new Date(data.created_at) : new Date();
    const expires = new Date(issued);
    // Valid 1 school year, not 2 — students move up a grade/section every
    // year, so last year's card is out of date info (class, stream, etc.)
    // even before the plastic wears out. A new one gets printed each year
    // with that year's details.
    expires.setFullYear(expires.getFullYear() + 1);
    const isExpired = expires < new Date();
    // The ID card itself always shows both languages side by side on every
    // field (like a national ID card), regardless of the site-wide EN/አማ
    // toggle elsewhere — it's a document, not just UI chrome, so it
    // doesn't make sense for it to switch away from Amharic entirely.
    const fmt = d => d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });

    // Ethiopian administrative address: woreda, zone, region — there's no
    // street-address field in this schema, so this is what "school address"
    // means here.
    const addressParts = [data.woreda, data.zone, data.region].filter(Boolean);
    const address = addressParts.length ? addressParts.join(', ') : t('idcard_address_not_set');

    container.innerHTML = `
        <div class="id-card-flip-wrap">
            <div class="id-card id-card-front">
                <div class="id-card-header">
                    <img src="/assets/images/Logo.png" alt="School logo" class="id-card-logo" onerror="this.style.display='none'">
                    <div class="id-card-header-text">
                        <div class="id-card-school-name">${data.school_name || 'School'}</div>
                        <div class="id-card-subtitle">የተማሪ መታወቂያ ካርድ | Student Identity Card</div>
                    </div>
                    <img src="/assets/images/gflag.jpg" alt="Gambella region flag" class="id-card-logo" onerror="this.style.display='none'">
                </div>
                <div class="id-card-body">
                    <div class="id-card-photo-col">
                        <div class="id-card-photo">${data.id_photo_url ? `<img src="${data.id_photo_url}" alt="ID photo">` : (initials || '?')}</div>
                        <div class="id-card-photo-label">ተማሪ | Student</div>
                    </div>
                    <div class="id-card-fields">
                        <div class="id-card-name">${full}</div>
                        <div><span class="id-label">የተማሪ መታወቂያ | Student ID</span><span>${data.student_id}</span></div>
                        <div><span class="id-label">ክፍል | Class</span><span>${t('profile_grade_value', { level: data.class_level })} - ${data.section}</span></div>
                        <div><span class="id-label">ትምህርት ዘርፍ | Stream</span><span>${data.stream || '—'}</span></div>
                        <div><span class="id-label">ስልክ ቁጥር | Contact</span><span>${data.phone_number || '—'}</span></div>
                        ${data.moe_school_code ? `<div><span class="id-label">የትምህርት ቤት ኮድ | School Code</span><span>${data.moe_school_code}</span></div>` : ''}
                    </div>
                </div>
                <div class="id-card-footer">
                    <div class="id-card-signature">
                        <img src="/assets/images/principal-signature.png" alt="Principal's signature" onerror="this.style.display='none'">
                        <div class="id-card-signature-line">ርዕሰ መምህር | Principal</div>
                    </div>
                    <div class="id-card-validity">
                        <span>የተሰጠበት | Issued: ${fmt(issued)}</span>
                        <strong class="${isExpired ? 'id-card-expired' : ''}">እስከ | Valid until: ${fmt(expires)}</strong>
                    </div>
                </div>
            </div>
            <div class="id-card id-card-back" style="display:none;">
                <div class="id-card-back-body">
                    <h4>${t('idcard_terms_heading')}</h4>
                    <ul class="id-card-terms">
                        <li>${t('idcard_term_property', { school: data.school_name || 'the school' })}</li>
                        <li>${t('idcard_term_nontransferable')}</li>
                        <li>${t('idcard_term_misuse')}</li>
                        <li>${t('idcard_term_validity')}</li>
                    </ul>
                    <div class="id-card-back-footer">
                        <p class="id-card-return-note">${t('idcard_return_note')}</p>
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
        showMsg(t('profile_fill_all_fields'), true);
        return;
    }
    if (newPass !== confirmPass) {
        showMsg(t('profile_passwords_no_match'), true);
        return;
    }
    if (newPass.length < 4) {
        showMsg(t('profile_password_too_short'), true);
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
            showMsg(t('profile_password_updated'), false);
            document.getElementById('curr-pass').value = '';
            document.getElementById('new-pass').value = '';
            document.getElementById('confirm-pass').value = '';
        } else {
            showMsg(data.error || t('profile_could_not_update_password'), true);
        }
    } catch (err) {
        showMsg(t('could_not_connect'), true);
    }
};

// ---- MARKS ----
let allMarks = [];

async function loadMarks() {
    const output = document.getElementById('marks-output');
    if (!output) return;
    output.innerHTML = `<p class="muted">${t('loading')}</p>`;
    try {
        const res = await apiFetch('/api/student/my-marks');
        if (!res.ok) throw new Error();
        allMarks = await res.json();
        populateTermFilter(allMarks);
        renderMarks(allMarks);
    } catch {
        output.innerHTML = `<p class="muted">${t('marks_could_not_load')}</p>`;
    }
}

function populateTermFilter(marks) {
    const sel = document.getElementById('marks-term-filter');
    if (!sel) return;
    const terms = [...new Set(marks.map(m => m.term).filter(Boolean))].sort();
    sel.innerHTML = `<option value="">${t('marks_all_terms')}</option>` +
        terms.map(term => `<option value="${term}">${term}</option>`).join('');
    sel.onchange = () => {
        const filtered = sel.value ? allMarks.filter(m => m.term === sel.value) : allMarks;
        renderMarks(filtered);
    };
}

// Assessment type labels are looked up via the shared t() dictionary
// (keys like assessment_quiz), so ASSESSMENT_TYPE_LABELS below is now
// just the source list of known types, not the English text itself.
const ASSESSMENT_TYPE_LABELS = { individual_assignment_1: 'Assignment 1', individual_assignment_2: 'Assignment 2',
    group_assignment: 'Group Assignment', quiz: 'Quiz', midterm: 'Midterm', final: 'Final' };
const ALL_ASSESSMENT_TYPES = Object.keys(ASSESSMENT_TYPE_LABELS);

// Falls back to a readable un-translated label (rather than a raw
// dictionary key) for any assessment/notification type this dictionary
// doesn't know about yet.
function assessmentLabel(type) {
    const key = 'assessment_' + type;
    const translated = t(key);
    return translated === key ? type.replace(/_/g, ' ') : translated;
}

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
    if (!marks.length) { output.innerHTML = `<p class="muted">${t('marks_none')}</p>`; return; }

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
                    ? t('marks_final', { pct: g.total.toFixed(1) })
                    : t('marks_total_so_far', { pct: g.total.toFixed(1), have: g.presentTypes.size, total: ALL_ASSESSMENT_TYPES.length });
                return `
                <div class="marks-term-group">
                    <div class="marks-term-header">
                        <span class="muted">${g.term}</span>
                        <span class="marks-avg">${totalLabel}</span>
                    </div>
                    <div class="marks-rows">
                        ${g.rows.map(r => `
                            <div class="marks-row">
                                <span class="marks-type">${assessmentLabel(r.type)}</span>
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
    output.innerHTML = `<p class="muted">${t('loading')}</p>`;
    try {
        const res = await apiFetch('/api/student/my-textbooks');
        if (!res.ok) throw new Error();
        const data = await res.json();
        renderTextbooks(data.books, output);
    } catch {
        output.innerHTML = `<p class="muted">${t('textbooks_could_not_load')}</p>`;
    }
}

function renderTextbooks(books, container) {
    if (!books.length) { container.innerHTML = `<p class="muted">${t('textbooks_none')}</p>`; return; }
    const statusBadge = {
        issued:   `<span class="badge badge-issued">${t('badge_issued')}</span>`,
        returned: `<span class="badge badge-returned">${t('badge_returned')}</span>`,
        lost:     `<span class="badge badge-lost">${t('badge_lost')}</span>`
    };
    container.innerHTML = `
        <div class="table-container">
            <table>
                <thead><tr><th>${t('textbooks_subject')}</th><th>${t('textbooks_status')}</th><th>${t('textbooks_issued_col')}</th><th>${t('textbooks_resolved_col')}</th></tr></thead>
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

// ---- ABSENCE / PERMISSION REQUESTS ----
let absenceAttachmentFile = null;

window.onAbsenceAttachmentChange = (inputEl) => {
    absenceAttachmentFile = inputEl.files[0] || null;
    const nameEl = document.getElementById('absence-attachment-filename');
    if (nameEl) nameEl.textContent = absenceAttachmentFile ? absenceAttachmentFile.name : '';
};

window.submitAbsenceRequest = async () => {
    const dateFrom = document.getElementById('absence-date-from').value;
    const dateTo = document.getElementById('absence-date-to').value;
    const reason = document.getElementById('absence-reason').value.trim();
    const msgEl = document.getElementById('absence-submit-message');

    const showMsg = (text, isError) => {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.style.color = isError ? '#dc2626' : '#16a34a';
    };

    if (!dateFrom || !dateTo || !reason) {
        showMsg(t('absence_fill_required'), true);
        return;
    }
    if (dateTo < dateFrom) {
        showMsg(t('absence_date_order_error'), true);
        return;
    }

    const formData = new FormData();
    formData.append('date_from', dateFrom);
    formData.append('date_to', dateTo);
    formData.append('reason', reason);
    if (absenceAttachmentFile) formData.append('attachment', absenceAttachmentFile);

    showMsg(t('absence_submitting'), false);
    try {
        const res = await apiFetch('/api/student/absence-requests', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
            showMsg('', false);
            showToast(t('absence_submitted'), 'success');
            document.getElementById('absence-date-from').value = '';
            document.getElementById('absence-date-to').value = '';
            document.getElementById('absence-reason').value = '';
            document.getElementById('absence-attachment-input').value = '';
            document.getElementById('absence-attachment-filename').textContent = '';
            absenceAttachmentFile = null;
            await loadAbsenceHistory();
        } else {
            showMsg(data.error || t('absence_submit_failed'), true);
        }
    } catch (err) {
        showMsg(t('could_not_connect'), true);
    }
};

async function loadAbsenceHistory() {
    const output = document.getElementById('absence-history-output');
    if (!output) return;
    output.innerHTML = `<p class="muted">${t('loading')}</p>`;
    try {
        const res = await apiFetch('/api/student/absence-requests');
        if (!res.ok) throw new Error();
        const requests = await res.json();
        renderAbsenceHistory(requests, output);
    } catch {
        output.innerHTML = `<p class="muted">${t('absence_could_not_load')}</p>`;
    }
}

function renderAbsenceHistory(requests, container) {
    if (!requests.length) { container.innerHTML = `<p class="muted">${t('absence_none')}</p>`; return; }
    const statusBadge = {
        pending:  `<span class="badge badge-issued">${t('badge_pending')}</span>`,
        approved: `<span class="badge badge-returned">${t('badge_approved')}</span>`,
        rejected: `<span class="badge badge-lost">${t('badge_rejected')}</span>`
    };
    const fmt = d => new Date(d).toLocaleDateString();
    container.innerHTML = requests.map(r => `
        <div class="widget" style="margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
                <strong>${fmt(r.date_from)}${r.date_from !== r.date_to ? ' – ' + fmt(r.date_to) : ''}</strong>
                ${statusBadge[r.status] || r.status}
            </div>
            <p style="margin-top:8px;">${escapeHtml(r.reason)}</p>
            ${r.attachment_url ? `<p class="muted" style="font-size:0.82rem; margin-top:4px;"><a href="${r.attachment_url}" target="_blank" rel="noopener">${t('absence_view_attachment')}</a></p>` : ''}
            ${r.status === 'rejected' && r.rejection_reason ? `<p class="request-status-box request-status-rejected" style="margin-top:8px;">${escapeHtml(r.rejection_reason)}</p>` : ''}
        </div>`).join('');
}

// ---- NOTIFICATIONS ----
let notifData = [];

async function loadNotifications() {
    const output = document.getElementById('notifications-output');
    try {
        const res = await apiFetch('/api/student/my-notifications');
        if (!res.ok) {
            if (output) output.innerHTML = `<p class="muted">${t('notifications_could_not_load')}</p>`;
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
        if (output) output.innerHTML = `<p class="muted">${t('notifications_could_not_load')}</p>`;
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
    if (!notifs.length) { container.innerHTML = `<p class="muted">${t('notifications_none')}</p>`; return; }
    container.innerHTML = notifs.map(n => `
        <div class="notif-card ${n.is_read ? '' : 'notif-unread'}" onclick="markRead(${n.notif_id}, this)">
            <div class="notif-card-header">
                <strong>${assessmentLabel(n.assessment_type)}</strong>
                ${n.is_read ? '' : '<span class="notif-dot" aria-label="Unread"></span>'}
            </div>
            <p class="notif-body">${escapeHtml(n.message)}</p>
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
        list.innerHTML = `<p class="notif-empty">${t('topbar_no_new_notifications')}</p>`;
        return;
    }
    list.innerHTML = notifData.slice(0, 5).map(n => `
        <div class="notif-item" onclick="markRead(${n.notif_id}, this); navigateTo('notifications')">
            <strong>${assessmentLabel(n.assessment_type)}</strong><br>
            ${escapeHtml(n.message.substring(0, 60))}${n.message.length > 60 ? '…' : ''}
        </div>`).join('');
}

window.toggleNotificationPanel = () => {
    const panel = document.getElementById('notification-panel');
    const btn = document.querySelector('.notification-btn');
    if (!panel) return;
    const isOpen = panel.style.display === 'block';
    panel.style.display = isOpen ? 'none' : 'block';
    if (btn) btn.setAttribute('aria-expanded', String(!isOpen));
    closeAccountMenu();
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
    if (e.key === 'Escape') { closeNotificationPanel(); closeAccountMenu(); }
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
        alert(t('help_fill_both'));
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
                <span class="muted">${t('dashboard_day_streak')}${data.streak > 0 ? ' ' + dots : ''}</span>
            </div>
            <p class="muted" style="margin-top:6px; font-size:0.8rem;">
                ${data.present_today ? t('dashboard_checked_in_today') : t('dashboard_not_checked_in')}
            </p>`;
    } catch {
        el.innerHTML = `<p class="muted">${t('dashboard_could_not_load_attendance')}</p>`;
    }
}

function updateDashboardSummary() {
    const el = document.getElementById('dashboard-summary');
    if (!el || !allMarks.length) {
        if (el) el.innerHTML = `<p class="muted">${t('dashboard_no_marks')}</p>`;
        return;
    }
    const grouped = computeSubjectTermTotals(allMarks);
    const completed = grouped.filter(g => g.isComplete);
    const subjects = new Set(allMarks.map(m => m.subject_name)).size;

    const avgBlock = completed.length
        ? `<div class="summary-stat"><span class="summary-num">${(completed.reduce((s, g) => s + g.total, 0) / completed.length).toFixed(1)}%</span><span class="muted">${t('dashboard_average')}</span></div>`
        : `<div class="summary-stat"><span class="summary-num">—</span><span class="muted">${t('dashboard_no_subject_graded')}</span></div>`;

    el.innerHTML = `
        ${avgBlock}
        <div class="summary-stat"><span class="summary-num">${allMarks.length}</span><span class="muted">${t('dashboard_assessments_recorded')}</span></div>
        <div class="summary-stat"><span class="summary-num">${subjects}</span><span class="muted">${t('dashboard_subjects')}</span></div>`;
}

function updateDashboardNotifs(notifs) {
    const el = document.getElementById('dashboard-notifs');
    if (!el) return;
    const recent = notifs.slice(0, 3);
    if (!recent.length) { el.innerHTML = `<p class="muted">${t('dashboard_no_notifications')}</p>`; return; }
    el.innerHTML = recent.map(n => `
        <div class="notif-card ${n.is_read ? '' : 'notif-unread'}" style="margin-bottom:8px;">
            <strong style="font-size:0.85rem;">${assessmentLabel(n.assessment_type)}</strong>
            <p class="muted" style="font-size:0.82rem; margin-top:2px;">${escapeHtml(n.message.substring(0, 80))}${n.message.length > 80 ? '…' : ''}</p>
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