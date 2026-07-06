document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); // Stop the form from refreshing the page

    const userId = document.getElementById('userId').value;
    const password = document.getElementById('password').value;
    const message = document.getElementById('message');

    try {
        const response = await fetch('http://localhost:3001/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include', // required so the httpOnly auth cookie the server sets is actually stored by the browser
                body: JSON.stringify({ id: userId, password: password })
            });

        const data = await response.json();

        if (response.ok) {
            // The real session lives in the httpOnly cookie the server just
            // set — it's invisible to this JS by design and that's correct.
            // We no longer store user_id/role in localStorage: every page
            // now asks the server "who am I?" via /api/me using the cookie,
            // rather than trusting whatever a script wrote into localStorage
            // (which a malicious script could also forge).

            message.style.color = "green";
            message.textContent = "Login successful! Redirecting...";

            // Redirect based on the role returned by the server
            // Ensure these folder names match your structure
            const redirectMap = {
                'students': '/student/', // Pointing to the folder
                'teachers': '/teachers/', // Changed from /teachers/teacher.html to /teachers/
                'admin_users': '/admin/',
                'registrar_users': '/registrar/'
            };

            window.location.href = redirectMap[data.role];
        } else {
            message.style.color = "red";
            message.textContent = data.error || "Login failed.";
        }
    } catch (err) {
        message.textContent = "Server error, please try again.";
    }
});
document.addEventListener('DOMContentLoaded', () => {
    const yearSpan = document.getElementById('currentYear');
    if (yearSpan) {
        yearSpan.textContent = new Date().getFullYear();
    }
});