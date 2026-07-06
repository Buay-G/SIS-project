// Check if user is authenticated
function checkAuth() {
    const userId = localStorage.getItem('user_id');
    const userRole = localStorage.getItem('user_role');

    // If no ID is found, send them back to login
    if (!userId || !userRole) {
        window.location.href = '/login.html'; 
    }
}

// Run the check immediately
checkAuth();