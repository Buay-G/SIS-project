/* portal-ui.js — small helpers shared by every portal.
 *
 *  1. PortalUI.upgradeError / showError / showEmpty
 *       Turns a plain "Could not load…" line into a clear message with a
 *       "Try again" button. Existing loaders call it right after they write
 *       their error text, so nothing else in the page has to change.
 *  2. API failure logging
 *       Any /api/ call that fails is logged to the browser console with its
 *       status code ("[portal] API request failed: 500 /api/…"). The message a
 *       person sees stays friendly; the real cause is one F12 away.
 *  3. Phone bottom tab bar (Home / … / More) built from the existing sidebar
 *       links, so it always follows the same permissions and translations.
 *  4. Teachers header: groups the year / MOE / semester chips into one row.
 *
 * Nothing here talks to the server or changes any data.
 */
(() => {
  'use strict';
  if (window.PortalUI) return;

  const TXT = {
    en: { more: 'More', retry: 'Try again', settings: 'Settings', help: 'Help', quick: 'Quick navigation' },
    am: { more: 'ተጨማሪ', retry: 'እንደገና ሞክር', settings: 'ቅንብሮች', help: 'እገዛ', quick: 'ፈጣን አሰሳ' },
  };
  const lang = () => { try { return localStorage.getItem('sis_lang') === 'am' ? 'am' : 'en'; } catch (e) { return 'en'; } };
  const tx = (k) => (TXT[lang()] || TXT.en)[k] || TXT.en[k];

  const svg = (inner) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  const ICON = {
    alert: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'),
    inbox: svg('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    refresh: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
    menu: svg('<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>'),
    dot: svg('<circle cx="12" cy="12" r="4"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>'),
    help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  };

  /* ---------- 2. API failure logging ---------- */
  const failures = [];
  function note(input, status, msg) {
    const url = String((input && input.url) || input || '').split('?')[0];
    if (!/\/api\//.test(url)) return;
    failures.push({ url, status, at: Date.now() });
    if (failures.length > 20) failures.shift();
    console.warn('[portal] API request failed:', status || 'network error', url, msg || '');
  }
  const recentFailure = () => {
    const f = failures[failures.length - 1];
    return f && Date.now() - f.at < 4000 ? f : null;
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    let res;
    try { res = await nativeFetch(...args); }
    catch (err) { note(args[0], 0, err && err.message); throw err; }
    if (!res.ok) note(args[0], res.status);
    return res;
  };

  /* ---------- 1. states ---------- */
  function stateEl({ text, kind, retry, hint }) {
    const d = document.createElement('div');
    d.className = 'pu-state' + (kind === 'error' ? ' is-error' : '');
    d.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    d.innerHTML = '<span class="pu-state-icon">' + (kind === 'error' ? ICON.alert : ICON.inbox) + '</span>';
    const p = document.createElement('div');
    p.className = 'pu-state-text';
    p.textContent = text;
    d.appendChild(p);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'pu-state-hint';
      h.textContent = hint;
      d.appendChild(h);
    }
    if (typeof retry === 'function') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pu-retry';
      b.innerHTML = ICON.refresh + '<span></span>';
      b.lastChild.textContent = tx('retry');
      b.addEventListener('click', () => {
        b.disabled = true;
        let r;
        try { r = retry(); } catch (e) { console.error(e); }
        if (r && typeof r.finally === 'function') r.finally(() => { b.disabled = false; });
        else b.disabled = false;
      });
      d.appendChild(b);
    }
    return d;
  }
  function showError(el, text, retry) {
    if (!el) return;
    const f = recentFailure();
    el.textContent = '';
    el.appendChild(stateEl({ text, kind: 'error', retry, hint: f ? (f.status ? 'HTTP ' + f.status : 'Network error') + ' · ' + f.url : '' }));
  }
  function showEmpty(el, text) {
    if (!el) return;
    el.textContent = '';
    el.appendChild(stateEl({ text, kind: 'empty' }));
  }
  /* Replace the last <p> error line an existing loader just wrote (or the whole box if it has none). */
  function upgradeError(el, retry) {
    try {
      if (!el || !el.querySelectorAll) return;
      const ps = el.querySelectorAll(':scope > p, :scope > div > p');
      const p = ps.length ? ps[ps.length - 1] : null;
      const text = (p ? p.textContent : el.textContent).trim();
      if (!text) return;
      const f = recentFailure();
      const node = stateEl({ text, kind: 'error', retry, hint: f ? (f.status ? 'HTTP ' + f.status : 'Network error') + ' · ' + f.url : '' });
      if (p) p.replaceWith(node); else { el.textContent = ''; el.appendChild(node); }
    } catch (e) { console.warn('[portal] upgradeError', e); }
  }

  /* ---------- 3. bottom tab bar ---------- */
  // pages: menu links found by data-page. pick: the first N visible menu items matching a selector
  // (for portals whose menu is drawn by JavaScript and has no data-page attributes).
  const TABS = {
    teachers: { pages: ['dashboard', 'students', 'upload', 'reports'] },
    students: { pages: ['dashboard', 'marks', 'notifications', 'absence'] },
    guardians: { pages: ['dashboard', 'profile'] },
    'school-admin': { pages: ['dashboard', 'students', 'absence', 'messages'] },
    registrar: { pick: '#sidebar .sidebar-nav button', count: 4 },
    'zonal-admin': { pick: '#navScroll .nav-item', count: 4 },
    'super-admin': { pick: '#navScroll .nav-item', count: 4 },
  };
  const TOGGLE_SEL = '#sidebar-toggle, #navOpenBtn, .nav-open-btn, .sidebar-hamburger, .sidebar-toggle-btn, .menu-toggle, [aria-controls="sidebar"]';
  const labelOf = (link) => {
    const s = link.querySelector('span[data-i18n], .nav-item-label') || Array.from(link.querySelectorAll('span')).pop();
    return ((s || link).textContent || '').trim();
  };
  function resolveLinks(cfg, sidebar) {
    if (cfg.pages) {
      return cfg.pages
        .map((p) => sidebar.querySelector('a[data-page="' + p + '"], button[data-page="' + p + '"]'))
        .filter(Boolean);
    }
    return Array.from(document.querySelectorAll(cfg.pick)).filter((el) => el.getClientRects().length > 0).slice(0, cfg.count);
  }
  function buildTabbar(portal, sidebar) {
    const cfg = TABS[portal];
    const toggle = document.querySelector(TOGGLE_SEL);
    if (!cfg || !sidebar || !toggle) return null;
    let links = resolveLinks(cfg, sidebar);
    if (links.length < 2) return null;
    const nav = document.createElement('nav');
    nav.className = 'pu-tabbar';
    nav.setAttribute('aria-label', tx('quick'));
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'pu-tab';
    more.innerHTML = ICON.menu + '<span></span>';
    more.addEventListener('click', () => toggle.click());
    nav.appendChild(more);
    let items = [];
    const rebuild = (fresh) => {
      items.forEach(({ b }) => b.remove());
      links = fresh;
      items = fresh.map((link) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pu-tab';
        const icon = link.querySelector('svg');
        b.innerHTML = (icon ? icon.outerHTML : ICON.dot) + '<span></span>';
        if (!icon) b.dataset.fallback = '1';
        // the menu item may be drawn again later, so always click the live element
        b.addEventListener('click', () => { const el = b._link; if (el && el.isConnected) el.click(); });
        b._link = link;
        nav.insertBefore(b, more);
        return { b, link };
      });
    };
    rebuild(links);
    document.body.appendChild(nav);
    document.body.classList.add('has-tabbar');
    return () => {
      // Some portals (zonal / super admin, registrar) draw their menu again after login or on
      // a language change. The old links are then gone, so pick up the new ones.
      const fresh = resolveLinks(cfg, sidebar);
      if (fresh.length >= 2 && (fresh.length !== links.length || fresh.some((l, i) => l !== links[i]))) rebuild(fresh);
      items.forEach(({ b, link }) => {
        if (b.dataset.fallback) {
          const icon = link.querySelector('svg');
          if (icon) { const tmp = document.createElement('div'); tmp.innerHTML = icon.outerHTML; b.firstElementChild.replaceWith(tmp.firstElementChild); delete b.dataset.fallback; }
        }
        b.hidden = link.getClientRects().length === 0;
        b.classList.toggle('is-active', link.classList.contains('active'));
        if (link.classList.contains('active')) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        b.lastElementChild.textContent = labelOf(link);
      });
      more.lastElementChild.textContent = tx('more');
    };
  }

  /* "Settings" and "Help" live in the header on desktop; on phones they move into the menu drawer. */
  function addDrawerExtras(portal, sidebar) {
    const menu = sidebar && (sidebar.querySelector('.nav-menu') || sidebar.querySelector('.sidebar-nav') || sidebar.querySelector('ul'));
    if (!menu) return null;
    const defs = [];
    if (portal === 'teachers') defs.push(['settings', document.getElementById('settings-btn'), ICON.gear]);
    if (portal === 'registrar') defs.push(['settings', document.querySelector('.settings-btn'), ICON.gear]);
    if (portal === 'teachers' || portal === 'students' || portal === 'guardians') {
      defs.push(['help', document.getElementById('help-btn') || document.getElementById('help-btn-open'), ICON.help]);
    }
    const isList = menu.tagName === 'UL';
    const sample = menu.querySelector('button, a');
    const made = [];
    defs.forEach(([key, btn, icon]) => {
      if (!btn) return;
      const a = document.createElement(isList ? 'a' : 'button');
      if (isList) a.href = '#'; else a.type = 'button';
      a.className = (sample && sample.className ? sample.className.replace(/\bactive\b/g, '').trim() : 'nav-link');
      if (isList) a.style.flex = '1';
      a.innerHTML = icon + '<span></span>';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const overlay = document.getElementById('sidebar-overlay') || document.querySelector('.sidebar-overlay');
        if (overlay) overlay.click();
        btn.click();
      });
      let host = a;
      if (isList) { host = document.createElement('li'); host.appendChild(a); }
      host.classList.add('pu-mobile-only');
      menu.appendChild(host);
      made.push([key, a]);
    });
    return () => made.forEach(([key, a]) => { a.lastElementChild.textContent = tx(key); });
  }

  /* ---------- 4. header chips ---------- */
  function groupChips(ids) {
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (els.length < 2 || !els[0].parentElement || els[0].parentElement.classList.contains('pu-chips')) return;
    const wrap = document.createElement('div');
    wrap.className = 'pu-chips';
    els[0].parentElement.insertBefore(wrap, els[0]);
    els.forEach((e) => wrap.appendChild(e));
  }
  /* School admin: on phones the academic-year chip joins the other chips (one row); on desktop it goes back. */
  function adoptYearChipOnPhones() {
    const year = document.querySelector('.top-academic-year');
    const meta = document.querySelector('.topbar-school-meta');
    if (!year || !meta || !year.parentElement) return;
    const home = year.parentElement;
    const mq = window.matchMedia('(max-width: 900px)');
    const place = () => {
      if (mq.matches) { if (year.parentElement !== meta) meta.insertBefore(year, meta.firstChild); }
      else if (year.parentElement !== home) home.appendChild(year);
    };
    place();
    if (mq.addEventListener) mq.addEventListener('change', place); else if (mq.addListener) mq.addListener(place);
  }

  function init() {
    const portal = document.body && document.body.dataset.portal;
    if (!portal) return;
    if (portal === 'teachers') groupChips(['academic-year-badge', 'moe-code-badge', 'semester-status-badge']);
    if (portal === 'registrar') groupChips(['topbar-moe-code', 'topbar-semester', 'topbar-academic-year']);
    if (portal === 'school-admin') adoptYearChipOnPhones();
    const sidebar = document.getElementById('sidebar') || document.querySelector('.sidebar');
    if (!sidebar) return;
    const syncs = [];
    let tabsBuilt = !TABS[portal];
    const tryBuildTabs = () => {
      if (tabsBuilt) return;
      try { const s = buildTabbar(portal, sidebar); if (s) { tabsBuilt = true; syncs.push(s); } } catch (e) { tabsBuilt = true; console.warn('[portal] tab bar', e); }
    };
    tryBuildTabs();
    if (['teachers', 'students', 'guardians', 'registrar'].includes(portal)) {
      try { const s = addDrawerExtras(portal, sidebar); if (s) syncs.push(s); } catch (e) { console.warn('[portal] drawer extras', e); }
    }
    let queued = false;
    const run = () => { queued = false; tryBuildTabs(); syncs.forEach((s) => s()); };
    const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
    // Menus drawn by JavaScript after login (zonal / super admin, registrar) show up here.
    new MutationObserver(schedule).observe(sidebar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.lang-switch-btn')) setTimeout(schedule, 60); });
    run();
  }

  window.PortalUI = { showError, showEmpty, upgradeError, recentFailure };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
