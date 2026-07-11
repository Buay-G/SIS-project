// School Hub — a standalone page (separate from the student/teacher
// portals), but NOT a public page. It reuses the same login session
// cookie those portals use, so every request below still carries
// req.user.school_id on the backend. That's what actually enforces
// multitenancy: a student or teacher from School A can open this page
// and will only ever see School A's announcements, gallery, and stats —
// never School B's — because the backend never trusts anything from the
// client to decide whose data to return.
//
// Two separate language concepts on this page, don't confuse them:
//   1. Site UI language (the EN/አማ switch in the hero) — controls this
//      page's own labels, via the shared i18n.js t() dictionary.
//   2. Content language (the per-section filter dropdowns) — which
//      language a given post/announcement was WRITTEN in by admin,
//      stored per-row in the database. Same dictionary keys
//      (hub_lang_english etc.) happen to supply both, since the display
//      names are the same either way.

async function apiFetch(url, opts = {}) {
    return fetch(url, { credentials: 'include', ...opts });
}

window.goBack = () => {
    // Opened as a new tab from a portal link, so there's usually no
    // in-tab history to go back to — closing the tab returns the user
    // to the portal tab they came from. Fall back to history.back() for
    // the (less common) case where hub.html was navigated to directly.
    if (window.history.length > 1) {
        window.history.back();
    } else {
        window.close();
    }
};

let cachedSchoolName = '';
let announcementsData = [];
let galleryData = [];

async function init() {
    try {
        const res = await apiFetch('/api/me');
        if (!res.ok) { window.location.href = '/login.html'; return; }
        const me = await res.json();
        cachedSchoolName = me.school_name || '';
        renderSchoolName();
    } catch {
        window.location.href = '/login.html';
        return;
    }
    loadStats();
    loadAnnouncements();
    loadGallery();

    document.getElementById('hub-announcements-lang')?.addEventListener('change', renderAnnouncements);
    document.getElementById('hub-gallery-lang')?.addEventListener('change', renderGallery);
}

function renderSchoolName() {
    const nameEl = document.getElementById('hub-school-name');
    if (nameEl) nameEl.textContent = cachedSchoolName || 'School Hub';
    if (cachedSchoolName) document.title = `${cachedSchoolName} — ${t('nav_hub')}`;
}

// i18n.js's setLang() calls this after switching the site language and
// re-running applyTranslations() on static text — this re-renders
// everything built as HTML strings with t() baked in.
window.onSisLangChange = () => {
    renderSchoolName();
    renderAnnouncements();
    renderGallery();
};

// content-language key -> shared dictionary key (also used for the site
// switch's language *names*, not the switch itself)
function langLabel(lang) {
    return t('hub_lang_' + (lang || 'english'));
}

async function loadStats() {
    const el = document.getElementById('hub-stats');
    if (!el) return;
    try {
        const res = await apiFetch('/api/school/stats');
        if (!res.ok) throw new Error();
        const data = await res.json();
        el.innerHTML = `
            <div class="hub-stat"><span class="hub-stat-num">${data.student_count}</span><span class="hub-stat-label">${t('hub_stat_students')}</span></div>
            <div class="hub-stat"><span class="hub-stat-num">${data.teacher_count}</span><span class="hub-stat-label">${t('hub_stat_teachers')}</span></div>`;
    } catch (err) {
        console.error('Hub stats error:', err);
        el.innerHTML = '';
    }
}

async function loadAnnouncements() {
    const output = document.getElementById('hub-announcements');
    if (!output) return;
    try {
        const res = await apiFetch('/api/announcements');
        if (!res.ok) throw new Error();
        announcementsData = await res.json();
        renderAnnouncements();
    } catch (err) {
        console.error('Hub announcements error:', err);
        output.innerHTML = `<p class="hub-muted">${t('hub_could_not_load_announcements')}</p>`;
    }
}

function renderAnnouncements() {
    const output = document.getElementById('hub-announcements');
    if (!output) return;
    const filter = document.getElementById('hub-announcements-lang')?.value || '';
    const items = filter ? announcementsData.filter(a => a.language === filter) : announcementsData;

    if (!items.length) {
        output.innerHTML = `<p class="hub-muted">${announcementsData.length ? t('hub_no_announcements_lang') : t('hub_no_announcements')}</p>`;
        return;
    }
    const dateLocale = getCurrentLang() === 'am' ? 'am-ET' : undefined;
    output.innerHTML = items.map(a => `
        <article class="hub-card">
            <div class="hub-card-header">
                <h3>${a.title}</h3>
                <span class="hub-lang-badge">${langLabel(a.language)}</span>
            </div>
            <p>${a.body}</p>
            <p class="hub-meta">${new Date(a.posted_at).toLocaleDateString(dateLocale, { year: 'numeric', month: 'long', day: 'numeric' })} ${t('hub_posted_by')}</p>
        </article>`).join('');
}

async function loadGallery() {
    const output = document.getElementById('hub-gallery');
    if (!output) return;
    try {
        const res = await apiFetch('/api/gallery');
        if (!res.ok) throw new Error();
        galleryData = await res.json();
        renderGallery();
    } catch (err) {
        console.error('Hub gallery error:', err);
        output.innerHTML = `<p class="hub-muted">${t('hub_could_not_load_gallery')}</p>`;
    }
}

function renderGallery() {
    const output = document.getElementById('hub-gallery');
    if (!output) return;
    const filter = document.getElementById('hub-gallery-lang')?.value || '';
    const items = filter ? galleryData.filter(p => p.language === filter) : galleryData;

    if (!items.length) {
        output.innerHTML = `<p class="hub-muted">${galleryData.length ? t('hub_no_posts_lang') : t('hub_no_posts')}</p>`;
        return;
    }
    output.innerHTML = items.map(p => {
        const langBadge = `<span class="hub-lang-badge">${langLabel(p.language)}</span>`;
        if (p.image_url) {
            return `
            <figure class="hub-gallery-item">
                <img src="${p.image_url}" alt="${p.body ? p.body.replace(/"/g, '&quot;') : 'School gallery photo'}" loading="lazy">
                <figcaption>
                    ${langBadge}
                    ${p.body ? `<span class="hub-gallery-caption-text">${p.body}</span>` : ''}
                </figcaption>
            </figure>`;
        }
        // Text-only post — no photo, just body text, styled as a note card
        // rather than an image tile so it doesn't leave an empty image box.
        return `
        <div class="hub-gallery-item hub-gallery-textonly">
            <div class="hub-gallery-textonly-body">${langBadge}<p>${p.body || ''}</p></div>
        </div>`;
    }).join('');
}

document.addEventListener('DOMContentLoaded', init);