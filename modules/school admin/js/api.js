// js/api.js
async function fetchStudents(stream, grade, section) {
    try {
        // Construct the URL with query parameters
        // The '||' handles cases where the value is null or undefined
        const url = `/dashboard-data?stream=${stream || ''}&grade=${grade || ''}&section=${section || ''}`;
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error('Failed to fetch filtered data');
        }
        
        return await response.json();
    } catch (error) {
        console.error("Error fetching data:", error);
        return []; // Return an empty array so the app doesn't crash
    }
}