// guard.js — included at the top of every protected portal page.
// Verifies the session cookie is valid by asking the server.
// If not authenticated, redirects to login immediately.
// If the user's role doesn't match this portal, also redirects.
(async () => {
    const PORTAL_ROLE = document.documentElement.dataset.role || null;

    try {
        const res = await fetch('/api/me', { credentials: 'include' });
        if (!res.ok) {
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