// ==========================================================
// SCHOOL HUB — shared by every signed-in role (students, teachers,
// school_admins, registrar, zonal_admins). Read access is open to
// anyone logged in at the school; posting/deleting is restricted to
// school_admins by the backend (/api/announcements, /api/gallery), so
// this file just hides the composer UI for everyone else — the real
// enforcement lives server-side.
// ==========================================================

const API_BASE = 'http://localhost:3001';

function apiFetch(url, options = {}) {
    return fetch(url, { credentials: 'include', ...options });
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function showToast(message, type = '') {
    const container = document.getElementById('hub-toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type ? 'toast-' + type : ''}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

// Same Ethiopian-calendar-aware date formatting the rest of the site uses,
// falling back to a plain locale string if ethiopian-calendar.js isn't
// loaded on whichever portal embeds this page.
function formatEthDate(dateInput) {
    if (!dateInput) return '—';
    if (typeof EthCal === 'undefined') {
        const d = new Date(dateInput);
        return isNaN(d.getTime()) ? String(dateInput) : d.toLocaleDateString();
    }
    const arg = (dateInput instanceof Date) ? dateInput : String(dateInput).slice(0, 10);
    try {
        return EthCal.formatWithGC(arg, { lang: getCurrentLang(), gcLabel: t('sa_eth_cal_gc') });
    } catch {
        return String(dateInput);
    }
}
function formatEthDateTime(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${formatEthDate(d)} · ${timeStr}`;
}

const LANG_LABEL_KEYS = {
    english: 'hub_lang_english',
    amharic: 'hub_lang_amharic',
    nuer: 'hub_lang_nuer',
    anuak: 'hub_lang_anuak',
};

// Where "Back to Portal" sends each role — matches the static module
// mounts in server.js (app.use('/school-admin', ...), etc). students
// was pointing at the old generic '/portal/' mount instead of the
// role-named '/students/' one every other entry here follows — that
// sent a student back to a stale/legacy folder instead of the actual
// student portal, regardless of which portal they'd come from.
const PORTAL_HOME_BY_ROLE = {
    school_admins: '/school-admin/',
    teachers: '/teachers/',
    students: '/students/',
    registrar_users: '/registrar/',
    zonal_admins: '/zonal-admin/',
    super_admins: '/super-admin/',
};

let CURRENT_ME = null;
let ANNOUNCEMENTS_CACHE = [];
let GALLERY_CACHE = [];
let LANG_FILTER = '';
let HUB_VIEW = 'news';
let SELECTED_ANNOUNCEMENT_ID = null;

// Re-runs lucide's icon replacement over any [data-lucide] element currently
// in the DOM. Needed after every innerHTML re-render (announcements, gallery,
// the admin modal) since those elements are injected after lucide's initial
// page-load pass. Guarded in case the CDN script hasn't loaded yet.
function refreshIcons() {
    if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
}

// Fetches an image (same-origin API host) and forces a real download via a
// temporary blob link, rather than relying on the `download` attribute alone
// — that attribute is unreliable for cross-origin URLs like our API host,
// which is exactly what every hub image is served from.
async function downloadImage(url, suggestedName) {
    try {
        const res = await apiFetch(url);
        if (!res.ok) throw new Error();
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = suggestedName || 'photo.jpg';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
    } catch {
        showToast(t('hub_download_failed'), 'error');
    }
}

// ---------- Generic modal helper (same pattern as the rest of the site) ----------
function openModal(innerHtml, extraClass) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'hub-generic-modal';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    const box = document.createElement('div');
    box.className = extraClass ? `modal-box ${extraClass}` : 'modal-box';
    box.innerHTML = innerHtml;
    overlay.appendChild(box);
    document.getElementById('hub-modal-root').appendChild(overlay);
}
function closeModal() {
    document.getElementById('hub-generic-modal')?.remove();
}

// ---------- Init ----------
async function initHub() {
    try {
        const res = await apiFetch(`${API_BASE}/api/me`);
        if (!res.ok) { window.location.href = '/login.html'; return; }
        CURRENT_ME = await res.json();
    } catch {
        window.location.href = '/login.html';
        return;
    }

    document.getElementById('hub-school-name').textContent = CURRENT_ME.school_name || '—';
    if (CURRENT_ME.logo_url) {
        document.getElementById('hub-logo-badge').innerHTML =
            `<img src="${API_BASE}${CURRENT_ME.logo_url}" alt="" />`;
    }
    document.getElementById('hub-back-link').href = PORTAL_HOME_BY_ROLE[CURRENT_ME.role] || '/login.html';
    renderFooter();

    if (CURRENT_ME.role === 'school_admins') {
        document.getElementById('hub-manage-btn').style.display = '';
        document.getElementById('hub-manage-btn').addEventListener('click', () => openHubAdminModal());
        loadSchoolStats();
    }

    document.getElementById('hub-lang-filter').addEventListener('change', (e) => {
        LANG_FILTER = e.target.value;
        renderAnnouncements();
        renderGallery();
    });

    document.getElementById('hub-tab-news').addEventListener('click', () => switchHubView('news'));
    document.getElementById('hub-tab-gallery').addEventListener('click', () => switchHubView('gallery'));

    loadAnnouncements();
    loadGallery();
    refreshIcons();
}

// Footer's "creative heartbeat" line names the school, so it's built from
// t() + the school name rather than a static data-i18n attribute.
function renderFooter() {
    const el = document.getElementById('hub-footer');
    if (!el) return;
    el.textContent = t('hub_footer', { school: CURRENT_ME?.school_name || '' });
}

// Toggles which of News / Gallery is visible — the Gallery link now lives
// as a tab in the section nav instead of always being shown side-by-side,
// which also keeps things usable on small screens.
function switchHubView(view) {
    HUB_VIEW = view;
    document.getElementById('hub-tab-news').classList.toggle('active', view === 'news');
    document.getElementById('hub-tab-gallery').classList.toggle('active', view === 'gallery');
    document.getElementById('hub-tab-news').setAttribute('aria-selected', String(view === 'news'));
    document.getElementById('hub-tab-gallery').setAttribute('aria-selected', String(view === 'gallery'));
    document.getElementById('hub-view-news').classList.toggle('active', view === 'news');
    document.getElementById('hub-view-gallery').classList.toggle('active', view === 'gallery');
}

async function loadSchoolStats() {
    const res = await apiFetch(`${API_BASE}/api/school/stats`);
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('hub-stat-students').textContent = data.student_count ?? '—';
    document.getElementById('hub-stat-teachers').textContent = data.teacher_count ?? '—';
    document.getElementById('hub-stats').style.display = '';
}

// ---------- News & Announcements (public feed) ----------
async function loadAnnouncements() {
    const listEl = document.getElementById('hub-announcements-list');
    listEl.innerHTML = `<div class="hub-loading">${t('sa_loading')}</div>`;
    try {
        const res = await apiFetch(`${API_BASE}/api/announcements`);
        if (!res.ok) throw new Error();
        ANNOUNCEMENTS_CACHE = await res.json();
        renderAnnouncements();
    } catch {
        listEl.innerHTML = `<div class="hub-error">${t('hub_could_not_load_announcements')}</div>`;
    }
}

function renderAnnouncements() {
    const listEl = document.getElementById('hub-announcements-list');
    const detailEl = document.getElementById('hub-announcement-detail');
    if (!listEl || !detailEl) return;
    const rows = LANG_FILTER
        ? ANNOUNCEMENTS_CACHE.filter(a => a.language === LANG_FILTER)
        : ANNOUNCEMENTS_CACHE;

    if (rows.length === 0) {
        listEl.innerHTML = `<div class="hub-empty">${LANG_FILTER ? t('hub_no_announcements_lang') : t('hub_no_announcements')}</div>`;
        detailEl.innerHTML = `<div class="hub-empty">${t('hub_news_select_prompt')}</div>`;
        SELECTED_ANNOUNCEMENT_ID = null;
        return;
    }

    // Keep whatever's currently selected if it's still in the (possibly
    // filtered) list; otherwise fall back to the most recent announcement
    // so the detail pane is never left pointing at nothing.
    if (!rows.some(a => a.announcement_id === SELECTED_ANNOUNCEMENT_ID)) {
        SELECTED_ANNOUNCEMENT_ID = rows[0].announcement_id;
    }

    listEl.innerHTML = rows.map(a => `
        <button type="button" class="hub-news-list-item${a.announcement_id === SELECTED_ANNOUNCEMENT_ID ? ' active' : ''}" data-announcement-id="${a.announcement_id}">
            <div class="hub-news-list-item-title">${escapeHtml(a.title)}</div>
            <div class="hub-news-list-item-snippet">${escapeHtml(a.body)}</div>
            <div class="hub-news-list-item-meta">
                <span class="hub-lang-tag">${t(LANG_LABEL_KEYS[a.language] || 'hub_lang_english')}</span>
                <span class="hub-news-list-item-date">${formatEthDateTime(a.posted_at)}</span>
            </div>
        </button>`).join('');

    listEl.querySelectorAll('[data-announcement-id]').forEach(btn => {
        btn.addEventListener('click', () => selectAnnouncement(Number(btn.dataset.announcementId)));
    });

    renderAnnouncementDetail(rows);
    refreshIcons();
}

// Switches which announcement the right-hand pane is showing, without
// re-fetching or re-rendering the whole left-hand list.
function selectAnnouncement(id) {
    SELECTED_ANNOUNCEMENT_ID = id;
    document.querySelectorAll('.hub-news-list-item').forEach(el => {
        el.classList.toggle('active', Number(el.dataset.announcementId) === id);
    });
    const rows = LANG_FILTER
        ? ANNOUNCEMENTS_CACHE.filter(a => a.language === LANG_FILTER)
        : ANNOUNCEMENTS_CACHE;
    renderAnnouncementDetail(rows);
}

function renderAnnouncementDetail(rows) {
    const detailEl = document.getElementById('hub-announcement-detail');
    if (!detailEl) return;
    const a = rows.find(r => r.announcement_id === SELECTED_ANNOUNCEMENT_ID);
    if (!a) {
        detailEl.innerHTML = `<div class="hub-empty">${t('hub_news_select_prompt')}</div>`;
        return;
    }
    detailEl.innerHTML = `
        <div class="hub-news-card-top">
            <h3 class="hub-news-title">${escapeHtml(a.title)}</h3>
            <span class="hub-news-date">${formatEthDateTime(a.posted_at)}</span>
        </div>
        <div class="hub-news-body">${escapeHtml(a.body)}</div>
        ${a.image_url ? `
        <div class="hub-news-photo-wrap">
            <img class="hub-news-photo" src="${API_BASE}${a.image_url}" alt="" />
            ${a.image_caption ? `<div class="hub-news-photo-caption">${escapeHtml(a.image_caption)}</div>` : ''}
        </div>` : ''}
        <div class="hub-news-footer">
            <span class="hub-lang-tag">${t(LANG_LABEL_KEYS[a.language] || 'hub_lang_english')}</span>
            <span class="hub-posted-by">${t('hub_posted_by')}</span>
        </div>`;
    refreshIcons();
}

// ---------- School Gallery (public feed) ----------
async function loadGallery() {
    const gridEl = document.getElementById('hub-gallery-grid');
    gridEl.innerHTML = `<div class="hub-loading">${t('sa_loading')}</div>`;
    try {
        const res = await apiFetch(`${API_BASE}/api/gallery`);
        if (!res.ok) throw new Error();
        GALLERY_CACHE = await res.json();
        renderGallery();
    } catch {
        gridEl.innerHTML = `<div class="hub-error">${t('hub_could_not_load_gallery')}</div>`;
    }
}

function renderGallery() {
    const gridEl = document.getElementById('hub-gallery-grid');
    if (!gridEl) return;
    const rows = LANG_FILTER
        ? GALLERY_CACHE.filter(g => g.language === LANG_FILTER)
        : GALLERY_CACHE;
    if (rows.length === 0) {
        gridEl.innerHTML = `<div class="hub-empty">${LANG_FILTER ? t('hub_no_posts_lang') : t('hub_no_posts')}</div>`;
        return;
    }
    gridEl.innerHTML = rows.map(g => `
        <div class="hub-gallery-card">
            ${g.image_url ? `
            <div class="hub-gallery-photo-wrap">
                <img class="hub-gallery-photo" src="${API_BASE}${g.image_url}" alt="" />
                <button type="button" class="hub-gallery-download-btn" data-download-id="${g.photo_id}" title="${t('hub_download')}" aria-label="${t('hub_download')}">
                    <i data-lucide="download" class="hub-icon"></i>
                </button>
            </div>` : ''}
            ${g.body ? `<div class="hub-gallery-body">${escapeHtml(g.body)}</div>` : ''}
            <div class="hub-gallery-meta">
                <span class="hub-lang-tag">${t(LANG_LABEL_KEYS[g.language] || 'hub_lang_english')}</span>
                <span class="hub-news-date">${formatEthDate(g.posted_at)}</span>
            </div>
        </div>`).join('');

    gridEl.querySelectorAll('[data-download-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            const item = rows.find(g => String(g.photo_id) === btn.dataset.downloadId);
            if (!item || !item.image_url) return;
            const ext = (item.image_url.split('.').pop() || 'jpg').split('?')[0];
            downloadImage(`${API_BASE}${item.image_url}`, `${(CURRENT_ME?.school_name || 'school-gallery').replace(/\s+/g, '-')}-${item.photo_id}.${ext}`);
        });
    });
    refreshIcons();
}

// ---------- Admin composer modal (school_admins only) ----------
let HUB_ADMIN_TAB = 'announcements';

function openHubAdminModal() {
    if (!CURRENT_ME || CURRENT_ME.role !== 'school_admins') {
        showToast(t('hub_admin_access_denied'), 'error');
        return;
    }
    HUB_ADMIN_TAB = 'announcements';
    openModal(`
        <h3 data-i18n="hub_admin_existing_posts">${t('hub_admin_existing_posts')}</h3>
        <p class="form-hint" style="margin-top:-8px;margin-bottom:16px;" data-i18n="hub_admin_tagline">${t('hub_admin_tagline')}</p>

        <div class="hub-admin-tabs">
            <button class="hub-admin-tab active" id="hub-admin-tab-announcements" data-i18n="hub_news_heading">${t('hub_news_heading')}</button>
            <button class="hub-admin-tab" id="hub-admin-tab-gallery" data-i18n="hub_gallery_heading">${t('hub_gallery_heading')}</button>
        </div>

        <div class="hub-admin-panel active" id="hub-admin-panel-announcements">
            <div class="form-group">
                <label data-i18n="hub_admin_title_label">${t('hub_admin_title_label')}</label>
                <input type="text" id="hub-admin-title" />
            </div>
            <div class="form-group">
                <label data-i18n="hub_admin_body_label">${t('hub_admin_body_label')}</label>
                <textarea id="hub-admin-body"></textarea>
            </div>
            <div class="form-group">
                <label data-i18n="hub_admin_announcement_photo_label">${t('hub_admin_announcement_photo_label')}</label>
                <input type="file" id="hub-admin-announcement-photo" accept="image/*" />
            </div>
            <div class="form-group">
                <label data-i18n="hub_admin_announcement_caption_label">${t('hub_admin_announcement_caption_label')}</label>
                <input type="text" id="hub-admin-announcement-caption" />
            </div>
            <div class="form-group">
                <label data-i18n="hub_admin_language_label">${t('hub_admin_language_label')}</label>
                <select id="hub-admin-lang">
                    <option value="english">${t('hub_lang_english')}</option>
                    <option value="amharic">${t('hub_lang_amharic')}</option>
                    <option value="nuer">${t('hub_lang_nuer')}</option>
                    <option value="anuak">${t('hub_lang_anuak')}</option>
                </select>
            </div>
            <div class="form-actions">
                <button class="btn btn-accent" id="hub-admin-post-announcement" data-i18n="hub_admin_post">${t('hub_admin_post')}</button>
            </div>
            <div class="hub-manage-list" id="hub-admin-announcements-list"></div>
        </div>

        <div class="hub-admin-panel" id="hub-admin-panel-gallery">
            <div class="form-group">
                <label data-i18n="hub_admin_gallery_text_label">${t('hub_admin_gallery_text_label')}</label>
                <textarea id="hub-admin-gallery-text"></textarea>
            </div>
            <div class="form-group">
                <label data-i18n="hub_admin_gallery_photo_label">${t('hub_admin_gallery_photo_label')}</label>
                <input type="file" id="hub-admin-gallery-photo" accept="image/*" />
            </div>
            <div class="form-group">
                <label data-i18n="hub_admin_language_label">${t('hub_admin_language_label')}</label>
                <select id="hub-admin-gallery-lang">
                    <option value="english">${t('hub_lang_english')}</option>
                    <option value="amharic">${t('hub_lang_amharic')}</option>
                    <option value="nuer">${t('hub_lang_nuer')}</option>
                    <option value="anuak">${t('hub_lang_anuak')}</option>
                </select>
            </div>
            <div class="form-actions">
                <button class="btn btn-accent" id="hub-admin-post-gallery" data-i18n="hub_admin_post_gallery">${t('hub_admin_post_gallery')}</button>
            </div>
            <div class="hub-manage-list" id="hub-admin-gallery-list"></div>
        </div>

        <div class="form-actions">
            <button class="btn btn-ghost" onclick="closeModal()" data-i18n="sa_close">${t('sa_close')}</button>
        </div>
    `, 'modal-box-wide');

    document.getElementById('hub-admin-tab-announcements').addEventListener('click', () => switchHubAdminTab('announcements'));
    document.getElementById('hub-admin-tab-gallery').addEventListener('click', () => switchHubAdminTab('gallery'));
    document.getElementById('hub-admin-post-announcement').addEventListener('click', postAnnouncement);
    document.getElementById('hub-admin-post-gallery').addEventListener('click', postGalleryItem);

    renderHubAdminAnnouncementsList();
    renderHubAdminGalleryList();
    refreshIcons();
}

function switchHubAdminTab(tab) {
    HUB_ADMIN_TAB = tab;
    document.getElementById('hub-admin-tab-announcements').classList.toggle('active', tab === 'announcements');
    document.getElementById('hub-admin-tab-gallery').classList.toggle('active', tab === 'gallery');
    document.getElementById('hub-admin-panel-announcements').classList.toggle('active', tab === 'announcements');
    document.getElementById('hub-admin-panel-gallery').classList.toggle('active', tab === 'gallery');
}

function renderHubAdminAnnouncementsList() {
    const el = document.getElementById('hub-admin-announcements-list');
    if (!el) return;
    if (ANNOUNCEMENTS_CACHE.length === 0) {
        el.innerHTML = `<div class="hub-empty">${t('hub_admin_no_posts_yet')}</div>`;
        return;
    }
    el.innerHTML = ANNOUNCEMENTS_CACHE.map(a => `
        <div class="hub-manage-row">
            <div class="hub-manage-row-main">
                <div class="hub-manage-row-title">${escapeHtml(a.title)}</div>
                <div class="hub-manage-row-meta">${t(LANG_LABEL_KEYS[a.language] || 'hub_lang_english')} · ${formatEthDateTime(a.posted_at)}</div>
            </div>
            <button class="btn btn-sm btn-danger" onclick="deleteAnnouncement(${a.announcement_id})" data-i18n="hub_admin_delete">${t('hub_admin_delete')}</button>
        </div>`).join('');
}

function renderHubAdminGalleryList() {
    const el = document.getElementById('hub-admin-gallery-list');
    if (!el) return;
    if (GALLERY_CACHE.length === 0) {
        el.innerHTML = `<div class="hub-empty">${t('hub_admin_no_posts_yet')}</div>`;
        return;
    }
    el.innerHTML = GALLERY_CACHE.map(g => `
        <div class="hub-manage-row">
            ${g.image_url ? `<img class="hub-manage-row-thumb" src="${API_BASE}${g.image_url}" alt="" />` : ''}
            <div class="hub-manage-row-main">
                <div class="hub-manage-row-title">${escapeHtml(g.body || t('hub_gallery_heading'))}</div>
                <div class="hub-manage-row-meta">${t(LANG_LABEL_KEYS[g.language] || 'hub_lang_english')} · ${formatEthDate(g.posted_at)}</div>
            </div>
            <button class="btn btn-sm btn-danger" onclick="deleteGalleryItem(${g.photo_id})" data-i18n="hub_admin_delete">${t('hub_admin_delete')}</button>
        </div>`).join('');
}

async function postAnnouncement() {
    const title = document.getElementById('hub-admin-title').value.trim();
    const body = document.getElementById('hub-admin-body').value.trim();
    const language = document.getElementById('hub-admin-lang').value;
    const photoInput = document.getElementById('hub-admin-announcement-photo');
    const caption = document.getElementById('hub-admin-announcement-caption').value.trim();
    const photo = photoInput.files[0] || null;
    if (!title || !body) return showToast(t('hub_admin_fill_title_body'), 'error');

    const formData = new FormData();
    formData.append('title', title);
    formData.append('body', body);
    formData.append('language', language);
    if (photo) formData.append('photo', photo);
    if (caption) formData.append('photo_caption', caption);

    const btn = document.getElementById('hub-admin-post-announcement');
    btn.disabled = true; btn.textContent = t('hub_admin_posting');
    try {
        const res = await apiFetch(`${API_BASE}/api/announcements`, { method: 'POST', body: formData });
        if (!res.ok) throw new Error();
        showToast(t('hub_admin_posted'), 'success');
        document.getElementById('hub-admin-title').value = '';
        document.getElementById('hub-admin-body').value = '';
        photoInput.value = '';
        document.getElementById('hub-admin-announcement-caption').value = '';
        await loadAnnouncements();
        renderHubAdminAnnouncementsList();
    } catch {
        showToast(t('hub_admin_post_failed'), 'error');
    } finally {
        btn.disabled = false; btn.textContent = t('hub_admin_post');
    }
}

async function deleteAnnouncement(id) {
    if (!confirm(t('hub_admin_confirm_delete'))) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/announcements/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        showToast(t('hub_admin_deleted'), 'success');
        await loadAnnouncements();
        renderHubAdminAnnouncementsList();
    } catch {
        showToast(t('hub_admin_delete_failed'), 'error');
    }
}

async function postGalleryItem() {
    const bodyText = document.getElementById('hub-admin-gallery-text').value.trim();
    const fileInput = document.getElementById('hub-admin-gallery-photo');
    const language = document.getElementById('hub-admin-gallery-lang').value;
    const file = fileInput.files[0] || null;
    if (!bodyText && !file) return showToast(t('hub_admin_need_text_or_photo'), 'error');

    const formData = new FormData();
    if (bodyText) formData.append('body', bodyText);
    formData.append('language', language);
    if (file) formData.append('photo', file);

    const btn = document.getElementById('hub-admin-post-gallery');
    btn.disabled = true; btn.textContent = t('hub_admin_posting');
    try {
        const res = await apiFetch(`${API_BASE}/api/gallery`, { method: 'POST', body: formData });
        if (!res.ok) throw new Error();
        showToast(t('hub_admin_posted'), 'success');
        document.getElementById('hub-admin-gallery-text').value = '';
        fileInput.value = '';
        await loadGallery();
        renderHubAdminGalleryList();
    } catch {
        showToast(t('hub_admin_post_failed'), 'error');
    } finally {
        btn.disabled = false; btn.textContent = t('hub_admin_post_gallery');
    }
}

async function deleteGalleryItem(id) {
    if (!confirm(t('hub_admin_confirm_delete'))) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/gallery/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        showToast(t('hub_admin_deleted'), 'success');
        await loadGallery();
        renderHubAdminGalleryList();
    } catch {
        showToast(t('hub_admin_delete_failed'), 'error');
    }
}

// Re-render dynamic (t()-built) content when the UI language is switched —
// applyTranslations() in i18n.js already re-runs for data-i18n elements,
// this handles the rest (language tags, empty states, list rows).
window.onSisLangChange = () => {
    renderFooter();
    renderAnnouncements();
    renderGallery();
    if (document.getElementById('hub-generic-modal')) {
        renderHubAdminAnnouncementsList();
        renderHubAdminGalleryList();
    }
    refreshIcons();
};

document.addEventListener('DOMContentLoaded', initHub);