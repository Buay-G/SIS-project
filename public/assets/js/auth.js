// If already authenticated, redirect straight to the right portal
(async () => {
    try {
        const res = await fetch('/api/me', { credentials: 'include' });
        if (res.ok) {
            const data = await res.json();
            const map = {
                students:        '/students/',
                teachers:        '/teachers/',
                admin_users:     '/admin/',
                registrar_users: '/registrar/'
            };
            if (map[data.role]) window.location.href = map[data.role];
        }
    } catch {}
})();

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const userId  = document.getElementById('userId').value;
    const password = document.getElementById('password').value;
    const message  = document.getElementById('message');

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ id: userId, password: password })
        });

        const data = await response.json();

        if (response.ok) {
            message.style.color = 'green';
            message.textContent = 'Login successful! Redirecting…';

            const redirectMap = {
                students:        '/students/',
                teachers:        '/teachers/',
                admin_users:     '/admin/',
                registrar_users: '/registrar/'
            };

            window.location.href = redirectMap[data.role] || '/';
        } else {
            message.style.color = 'red';
            message.textContent = data.error || 'Login failed. Please check your ID and password.';
        }
    } catch {
        message.style.color = 'red';
        message.textContent = 'Could not connect to the server. Please try again.';
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const yearSpan = document.getElementById('currentYear');
    if (yearSpan) yearSpan.textContent = new Date().getFullYear();
});