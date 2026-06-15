let students = [];

// 1. Fetch the JSON data from your new folder
async function loadData() {
    try {
        const response = await fetch('/data/students.json');
        students = await response.json();
        console.log("Student data loaded successfully");
    } catch (error) {
        console.error("Error loading student data:", error);
    }
}

// Load data immediately when the file is included
loadData();

function search() {
    // 2. Prevent search if data hasn't loaded yet
    if (students.length === 0) return;

    const query = document.getElementById('studentSearch').value.toLowerCase();
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = '';

    if (query.length < 2) return;

    const filtered = students.filter(s => s["2"].toLowerCase().includes(query));
    
    filtered.slice(0, 5).forEach(student => {
        const div = document.createElement('div');
        div.className = 'result-item';
        div.innerHTML = `<span class="name-text">${student["2"]}</span><span class="class-tag">${student["3"]}</span>`;
        div.onclick = () => showDetail(student); 
        resultsDiv.appendChild(div);
    });
}

function showDetail(s) {
    document.getElementById('detSchool').innerText = s["1"];
    document.getElementById('detID').innerText = s["0"];
    document.getElementById('detName').innerText = s["2"];
    document.getElementById('detClass').innerText = s["3"];
    document.getElementById('detUser').innerText = s["4"];
    document.getElementById('detEmail').innerText = s["5"];
    document.getElementById('detPass').innerText = s["6"];
    document.getElementById('detPC').innerText = s["7"]; 
    
    document.getElementById('searchView').style.display = 'none';
    document.getElementById('detailView').style.display = 'block';
}

function showSearch() {
    document.getElementById('detailView').style.display = 'none';
    document.getElementById('searchView').style.display = 'block';
    document.getElementById('studentSearch').value = '';
    document.getElementById('searchResults').innerHTML = '';
}

// Ensure the form listener uses the correct element ID
document.getElementById('studentSearch').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        const firstResult = document.querySelector('.result-item');
        if (firstResult) {
            firstResult.click(); 
        }
    }
});