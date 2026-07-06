// js/logic.js

// Toggle Sidebar Dropdowns
function toggleDropdown(id) {
    document.getElementById(id).classList.toggle('show');
}

// Initial load: keep empty until a selection is made
document.addEventListener('DOMContentLoaded', () => {
    // Optional: renderTable(null, null, null);
});

// Main render function
async function renderTable(stream, grade, section) {
    const tbody = document.getElementById('student-table-body');
    
    // Show loading state
    tbody.innerHTML = "<tr><td colspan='5'>Loading...</td></tr>";

    // Fetch data from API
    const students = await fetchStudents(stream, grade, section);
    
    // Clear the loading message
    tbody.innerHTML = "";

    // Handle empty results
    if (students.length === 0) {
        tbody.innerHTML = "<tr><td colspan='5'>No students found for this selection.</td></tr>";
        return;
    }

    // Render rows
    students.forEach(student => {
        // Construct the full name, handling missing middle names gracefully
        const fullName = `${student.first_name || ''} ${student.middle_name || ''} ${student.last_name || ''}`.replace(/\s+/g, ' ').trim();

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${student.student_id}</td>
            <td>${fullName}</td>
            <td>${student.class_level}</td>
            <td>${student.stream || 'N/A'}</td>
            <td>${student.section}</td>
        `;
        tbody.appendChild(row);
    });
}

// Search functionality
function filterStudents() {
    const input = document.getElementById("searchInput").value.toLowerCase();
    const rows = document.getElementById("student-table-body").getElementsByTagName("tr");
    
    for (let row of rows) {
        // Skip the empty/no-data row
        if (row.cells.length < 2) continue; 
        
        const text = row.innerText.toLowerCase();
        row.style.display = text.includes(input) ? "" : "none";
    }
}
function exportTableToCSV(filename) {
    const table = document.getElementById("student-table");
    let csv = [];
    
    // Get all rows from the table
    for (let row of table.rows) {
        let rowData = [];
        for (let cell of row.cells) {
            // Escape quotes and wrap in quotes to handle commas within names
            let cellText = cell.innerText.replace(/"/g, '""');
            rowData.push('"' + cellText + '"');
        }
        csv.push(rowData.join(","));
    }
    
    // Create a Blob and trigger download
    const csvFile = new Blob([csv.join("\n")], { type: "text/csv" });
    const downloadLink = document.createElement("a");
    downloadLink.download = filename;
    downloadLink.href = window.URL.createObjectURL(csvFile);
    downloadLink.style.display = "none";
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
}