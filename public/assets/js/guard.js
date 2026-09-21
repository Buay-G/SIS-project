// guard.js — included at the top of every protected portal page.
// Verifies the session cookie is valid by asking the server.
// If not authenticated, redirects to login immediately.
// If the user's role doesn't match this portal, also redirects.
//
// Subscription Fee: if Super Admin has frozen this account, the server
// answers 403 with code SUBSCRIPTION_FROZEN (see requireAuth). This file
// turns that into a full-screen "account frozen" notice with only a
// Logout button — on page load (the /api/me check below) AND mid-session
// (every fetch() the portal makes is watched for that same response), so
// it works the same in every portal without touching each one's code.
(() => {
    const FROZEN_CODE = 'SUBSCRIPTION_FROZEN';
    const nativeFetch = window.fetch.bind(window);

    const TEXT = {
        en: {
            title: 'Account frozen',
            message: "You didn't pay your subscription fee. Please pay to access your account.",
            logout: 'Logout',
        },
        am: {
            title: 'መለያዎ ታግዷል',
            message: 'የደንበኝነት ክፍያዎን አልከፈሉም። መለያዎን ለመጠቀም እባክዎ ይክፈሉ።',
            logout: 'ውጣ',
        },
    };

    function showFrozenScreen() {
        if (document.getElementById('subscriptionFrozenScreen')) return;
        let lang = 'en';
        try { if (localStorage.getItem('sis_lang') === 'am') lang = 'am'; } catch (e) { /* storage blocked */ }
        const tx = TEXT[lang];

        const overlay = document.createElement('div');
        overlay.id = 'subscriptionFrozenScreen';
        overlay.setAttribute('role', 'alertdialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'subFrozenTitle');
        overlay.setAttribute('aria-describedby', 'subFrozenMsg');
        overlay.style.cssText =
            'position:fixed;inset:0;z-index:2147483647;background:#0d3324;display:flex;' +
            'align-items:center;justify-content:center;padding:20px;font-family:inherit;';

        const card = document.createElement('div');
        card.style.cssText =
            'background:#fff;border-radius:16px;max-width:420px;width:100%;padding:32px 26px 26px;' +
            'text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.35);color:#1c2b24;';

        const icon = document.createElement('div');
        icon.setAttribute('aria-hidden', 'true');
        icon.style.cssText =
            'width:56px;height:56px;border-radius:50%;background:#fbe4e4;color:#c0392b;margin:0 auto 16px;' +
            'display:flex;align-items:center;justify-content:center;';
        icon.innerHTML =
            '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/>' +
            '<path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

        const h = document.createElement('h2');
        h.id = 'subFrozenTitle';
        h.textContent = tx.title;
        h.style.cssText = 'font-size:20px;margin:0 0 10px;';

        const p = document.createElement('p');
        p.id = 'subFrozenMsg';
        p.textContent = tx.message;
        p.style.cssText = 'font-size:14.5px;line-height:1.55;margin:0 0 22px;color:#3d4d45;';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = tx.logout;
        btn.style.cssText =
            'background:#c99a4a;color:#0d3324;border:0;border-radius:10px;padding:11px 26px;font-size:14px;' +
            'font-weight:700;cursor:pointer;font-family:inherit;';
        btn.addEventListener('click', async () => {
            try { await nativeFetch('/api/logout', { method: 'POST', credentials: 'include' }); } catch (e) { /* redirect anyway */ }
            window.location.href = '/login.html';
        });

        card.append(icon, h, p, btn);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
        btn.focus();
    }

    // Watch every fetch() the portal makes for the frozen response. The
    // original Response is returned untouched (only a clone is read), so
    // nothing else in any portal changes behaviour.
    window.fetch = async (...args) => {
        const res = await nativeFetch(...args);
        if (res.status === 403) {
            res.clone().json().then((body) => {
                if (body && body.code === FROZEN_CODE) showFrozenScreen();
            }).catch(() => { /* not JSON — ignore */ });
        }
        return res;
    };

    (async () => {
        const PORTAL_ROLE = document.documentElement.dataset.role || null;

        try {
            const res = await fetch('/api/me', { credentials: 'include' });
            if (!res.ok) {
                // A frozen account gets the notice (shown by the fetch
                // watcher above), not a bounce to the login page.
                if (res.status === 403) {
                    const body = await res.clone().json().catch(() => ({}));
                    if (body && body.code === FROZEN_CODE) {
                        showFrozenScreen();
                        return;
                    }
                }
                window.location.href = '/login.html';
                return;
            }
            const data = await res.json();

            // If a data-role attribute is set on <html>, enforce it
            if (PORTAL_ROLE && data.role !== PORTAL_ROLE) {
                window.location.href = '/login.html';
            }
        } catch {
            window.location.href = '/login.html';
        }
    })();
})();