import express from 'express';
import mysql from 'mysql2';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- 1. Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// --- 2. Static File Serving ---

// 1. Everything in 'public' is available globally (CSS, JS, Images)
app.use(express.static(path.join(__dirname, 'public')));

// 2. Map Modules (Explicitly map the URL path to the specific folder)
// Note: These folders MUST contain an 'index.html' for the URL /module/ to work
app.use('/portal', express.static(path.join(__dirname, 'modules/portal')));
app.use('/fayda', express.static(path.join(__dirname, 'modules/fayda')));
app.use('/admin', express.static(path.join(__dirname, 'modules/admin')));
app.use('/library', express.static(path.join(__dirname, 'modules/library')));

// 3. Data folder
app.use('/data', express.static(path.join(__dirname, 'data')));

// --- 3. Database ---
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'B2000_mun@14',
    database: 'school_db'
});

// --- 4. API Endpoints ---
app.post('/submit', (req, res) => {
    const { student_id, first_name, middle_name, last_name, fayda_number, phone_number, fayda_status, class_level, sex, stream, section } = req.body;
    const cleanPhone = phone_number.startsWith('09') ? phone_number.substring(1) : phone_number;

    const sql = `INSERT INTO students (student_id, first_name, middle_name, last_name, fayda_number, phone_number, fayda_status, class_level, sex, stream, section) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    pool.query(sql, [student_id, first_name, middle_name, last_name, fayda_number, cleanPhone, fayda_status, class_level, sex, stream, section], (err, result) => {
        if (err) return res.status(500).json({ error: "Failed to save: " + err.message });
        return res.json({ message: "Registration successful!" });
    });
});

app.get('/dashboard-data', (req, res) => {
    const query = `SELECT student_id, first_name, middle_name, last_name, fayda_number, phone_number, class_level, stream, section FROM students ORDER BY student_id DESC`;
    pool.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});
console.log("Serving static files from:", path.join(__dirname, 'public'));
// Add this right before your "--- 2. Static File Serving ---" section
app.use((req, res, next) => {
    console.log(`[REQUEST]: ${req.method} ${req.url}`);
    next();
});

// --- 5. Server Start ---
app.listen(3001, () => console.log("SIS Server running on http://localhost:3001"));