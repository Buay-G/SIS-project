// --- 1. Tab Navigation ---
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.getElementById(tabId).classList.add('active');
}

// --- 2. Dynamic Stream Logic (Grade 9-12) ---
function updateStreamOptions() {
    const grade = document.getElementById('reg_grade').value;
    const streamSelect = document.getElementById('reg_stream');
    
    streamSelect.innerHTML = ''; 
    
    if (grade == '9' || grade == '10') {
        streamSelect.innerHTML = '<option value="General">General</option>';
    } else if (grade == '11' || grade == '12') {
        streamSelect.innerHTML = `
            <option value="Natural Science">Natural Science</option>
            <option value="Social Science">Social Science</option>
        `;
    } else {
        streamSelect.innerHTML = '<option value="">Select Stream</option>';
    }
}

// --- 3. Database Interactions ---

async function submitRegistration() {
    const btn = document.querySelector('button[onclick="submitRegistration()"]');
    const originalText = btn.innerText;
    
    const data = {
        fayda_number: document.getElementById('reg_fayda').value,
        phone_number: document.getElementById('reg_phone').value,
        first_name: document.getElementById('reg_first').value,
        middle_name: document.getElementById('reg_middle').value,
        last_name: document.getElementById('reg_last').value,
        class_level: document.getElementById('reg_grade').value,
        sex: document.getElementById('reg_sex').value,
        stream: document.getElementById('reg_stream').value
    };

    btn.innerText = "Registering...";
    btn.disabled = true;

    try {
        const res = await fetch('http://localhost:3001/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        const result = await res.json();

        if (res.ok) {
            const successMsg = document.querySelector('#success-modal p');
            successMsg.innerText = `Student Registered Successfully! ID: ${result.student_id} | Section: ${result.assignedSection} | PC: ${result.assigned_pc}`;
            showSuccess(); 
            document.getElementById('registration-form').reset();
            document.getElementById('reg_stream').innerHTML = '<option value="">Select Stream</option>';
        } else {
            alert("Registration Failed: " + (result.error || "Unknown error"));
        }
    } catch (err) {
        console.error(err);
        alert("Server connection error.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function fetchStudent() {
    const id = document.getElementById('search-id').value;
    if (!id) return alert("Please enter an ID!");

    const res = await fetch(`http://localhost:3001/api/student/${id}`);
    if (res.ok) {
        const data = await res.json();
        document.getElementById('upd_id').value = data.student_id;
        document.getElementById('upd_first').value = data.first_name;
        document.getElementById('upd_middle').value = data.middle_name;
        document.getElementById('upd_last').value = data.last_name;
        document.getElementById('upd_class').value = data.class_level;
        document.getElementById('upd_section').value = data.section;
        document.getElementById('upd_stream').value = data.stream;
        document.getElementById('upd_phone').value = data.phone_number;
        document.getElementById('upd_fayda').value = data.fayda_number;
        document.getElementById('upd_sex').value = data.sex;
    } else {
        alert("Student not found!");
    }
}

async function submitUpdate() {
    const id = document.getElementById('upd_id').value;
    if (!id) return alert("Search for a student first!");
    
    const data = {
        first_name: document.getElementById('upd_first').value,
        middle_name: document.getElementById('upd_middle').value,
        last_name: document.getElementById('upd_last').value,
        phone_number: document.getElementById('upd_phone').value,
        fayda_number: document.getElementById('upd_fayda').value,
        sex: document.getElementById('upd_sex').value,
        class_level: document.getElementById('upd_class').value, 
        stream: document.getElementById('upd_stream').value
    };

    try {
        const res = await fetch(`http://localhost:3001/api/update/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            showSuccess(); 
        } else {
            const errorText = await res.text();
            alert("Update failed: " + errorText);
        }
    } catch (err) {
        console.error("Fetch Error:", err);
        alert("Could not connect to the server.");
    }
}

async function fetchForPromotion() {
    const id = document.getElementById('promo-id').value.trim();
    const btn = document.querySelector('button[onclick="fetchForPromotion()"]');
    if (!id) return alert("Please enter a Student ID");

    btn.innerText = "Searching...";
    document.getElementById('promo-form').style.display = 'none';

    try {
        const res = await fetch(`http://localhost:3001/api/student/${id}`);
        if (!res.ok) throw new Error("Student not found.");
        
        const data = await res.json();
        const currentGrade = parseInt(data.class_level);

        if (isNaN(currentGrade)) throw new Error("Invalid grade level in database.");

        document.getElementById('promo-form').style.display = 'block';
        document.getElementById('student-name-display').innerText = `${data.first_name} ${data.last_name}`;
        document.getElementById('current-grade').innerText = currentGrade;
        
        const newGradeSelect = document.getElementById('new-grade');
        const streamContainer = document.getElementById('stream-select-container');
        const streamSelect = document.getElementById('stream-select');
        
        newGradeSelect.innerHTML = ''; 

        if (currentGrade >= 12) {
            alert("Student is already in Grade 12.");
            document.getElementById('promo-form').style.display = 'none';
        } else {
            newGradeSelect.innerHTML = `<option value="${currentGrade + 1}">Grade ${currentGrade + 1}</option>`;
            
            if (currentGrade === 10 || currentGrade === 11) {
                streamContainer.style.display = 'block';
                streamSelect.innerHTML = `
                    <option value="Natural Science">Natural Science</option>
                    <option value="Social Science">Social Science</option>
                `;
            } else {
                streamContainer.style.display = 'none';
            }
        }
    } catch (error) {
        console.error("Promotion Error:", error);
        alert(error.message);
    } finally {
        btn.innerText = "Search";
    }
}

async function submitPromotion() {
    const id = document.getElementById('promo-id').value;
    const data = {
        class_level: document.getElementById('new-grade').value, 
        stream: document.getElementById('stream-select').value || 'General'
    };

    const res = await fetch(`http://localhost:3001/api/promote/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    if (res.ok) {
        alert("Student promoted successfully!");
        location.reload(); 
    } else {
        alert("Promotion failed.");
    }
}

function showSuccess() {
    document.getElementById('success-modal').style.display = 'block';
}

function closeSuccess() {
    document.getElementById('success-modal').style.display = 'none';
    location.reload(); 
}