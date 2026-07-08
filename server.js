import express from 'express';
import mysql from 'mysql2';
import cors from 'cors'; 
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// CORS must explicitly name the origin (not '*') and enable credentials
// for httpOnly cookies to be sent/received cross-origin.
app.use(cors({
    origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3001',
    credentials: true
}));
app.use(cookieParser());

// Static Files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/student', express.static(path.join(__dirname, 'modules')));
app.use('/teachers', express.static(path.join(__dirname, 'modules/teachers')));
app.use('/portal', express.static(path.join(__dirname, 'modules/portal')));
app.use('/registrar', express.static(path.join(__dirname, 'modules/registrar')));
app.use('/admin', express.static(path.join(__dirname, 'modules/admin')));
app.use('/library', express.static(path.join(__dirname, 'modules/library')));
app.use('/uploads', express.static('uploads'));

// Database Pool — credentials now come from .env, never hardcoded here.
// See .env.example for the required variables.
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'school_db'
}).promise();

if (!process.env.DB_PASSWORD) {
    console.warn("WARNING: DB_PASSWORD is not set in your .env file. The database connection will likely fail.");
}
if (!process.env.JWT_SECRET) {
    console.warn("WARNING: JWT_SECRET is not set in your .env file. Using an insecure fallback — set this before deploying.");
}

// --- Auth: JWT issued at login, stored as an httpOnly cookie ---
// Never readable by frontend JS — closes off the XSS-reads-localStorage
// attack class that the previous localStorage-based approach was exposed to.
const JWT_SECRET = process.env.JWT_SECRET || 'insecure-dev-fallback-do-not-use-in-production';
const JWT_EXPIRES_IN = '30m'; // short-lived on purpose — see refresh notes below

function issueAuthToken(res, { user_id, role, school_id }) {
    const token = jwt.sign({ user_id, role, school_id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.cookie('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // requires HTTPS in production
        sameSite: 'strict',
        maxAge: 30 * 60 * 1000 // 30 minutes, matches JWT_EXPIRES_IN
    });
}

// Verifies the cookie on every protected route and attaches req.user.
// Routes should read req.user.school_id / req.user.user_id / req.user.role
// query string for anything security-relevant. The token is the only
// source of truth for "who is making this request."
function requireAuth(req, res, next) {
    const token = req.cookies?.auth_token;
    if (!token) {
        return res.status(401).json({ error: "Not logged in." });
    }
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ error: "Session expired or invalid. Please log in again." });
    }
}

// Restricts a route to specific roles, e.g. requireRole('teachers').
// Must run AFTER requireAuth, since it reads req.user.
function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: "You don't have permission to do this." });
        }
        next();
    };
}

// In-memory store for teacher notification/security preferences.
// NOTE: this is intentionally NOT persisted to the database — it resets
const teacherPreferences = new Map();

// The 6 fixed assessment types used across mark entry, bulk upload, and
// the conduct-status dashboard widget. Keep this in sync with the
// type values your frontend dropdown sends.
const ASSESSMENT_TYPES = [
    'individual_assignment_1',
    'individual_assignment_2',
    'group_assignment',
    'quiz',
    'midterm',
    'final'
];

// The fixed list of terms the school uses. Admin can only ever switch
// between these — not free text — to keep marks.term consistent.
const TERMS = ['Semester 1', 'Semester 2'];

// source of truth every mark gets auto-stamped with — teachers never pick
// a term themselves.
async function getCurrentTerm(school_id) {
    const [rows] = await pool.query(
        "SELECT setting_value FROM school_settings WHERE setting_key = 'current_term' AND school_id = ?",
        [school_id]
    );
    return rows.length > 0 ? rows[0].setting_value : 'Semester 1';
}

// Checks whether a subject's marks for a given section+term have already
// been pushed to the homeroom teacher. Once pushed, that combination is
// locked — no further marks of any type can be added or edited for it.
async function isPushedAndLocked(subject_id, class_level, section, stream, term, school_id) {
    const [rows] = await pool.query(
        `SELECT push_id FROM pushed_reports
         WHERE subject_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ? AND school_id = ?`,
        [subject_id, class_level, section, stream, term, school_id]
    );
    return rows.length > 0;
}

// --- API Endpoints ---

app.post('/api/register', requireAuth, requireRole('registrar_users'), async (req, res) => {
    // Each registration needs its own dedicated connection (not the shared
    // pool) so the transaction's lock and queries all happen on the same
    // underlying connection — required for FOR UPDATE row locking and
    // commit/rollback to behave correctly.
    const conn = await pool.getConnection();

    try {
        const { first_name, middle_name, last_name, fayda_number, phone_number, class_level, sex, stream } = req.body;

        // school_id comes from the authenticated session, never the request
        // body — otherwise a registrar could register a student under any
        // school's prefix just by changing what they send.
        const school_id = req.user.school_id;
        if (!school_id) {
            return res.status(400).json({ error: "Your account isn't linked to a school. Contact an administrator." });
        }

        await conn.beginTransaction();

        // FOR UPDATE locks this school's row for the rest of the transaction.
        // If two registrar requests for the SAME school arrive at the same
        // time, the second one now blocks here until the first commits or
        // rolls back — eliminating the old race where both could read the
        // same student count and generate the same student_id. Registrations
        // for DIFFERENT schools lock different rows and don't block each other.
        const [schoolRows] = await conn.query(
            'SELECT school_name, school_prefix FROM schools WHERE id = ? FOR UPDATE',
            [school_id]
        );
        if (schoolRows.length === 0) {
            await conn.rollback();
            return res.status(400).json({ error: "Could not find your school's record." });
        }
        const { school_name, school_prefix } = schoolRows[0];
        if (!school_prefix) {
            await conn.rollback();
            return res.status(400).json({ error: "Your school doesn't have a student ID prefix set yet. Contact an administrator." });
        }

        // Sequential 5-digit counter PER SCHOOL — e.g. NHS00001, NHS00002...
        // Safe now: the FOR UPDATE lock above guarantees no other
        // registration for this same school can read this count or insert
        // until this transaction commits.
        const [[{ studentCount }]] = await conn.query(
            'SELECT COUNT(*) as studentCount FROM students WHERE school_id = ?',
            [school_id]
        );
        const nextNumber = studentCount + 1;
        const student_id = `${school_prefix}${String(nextNumber).padStart(5, '0')}`;

        const lms_username = student_id;
        const email_address = `${student_id}@${school_prefix.toLowerCase()}.edu`;
        const plain_password = Math.floor(100000 + Math.random() * 900000).toString();
        const security_password = await bcrypt.hash(plain_password, 10);
        const assigned_pc = `PC-${Math.floor(Math.random() * 39) + 1}`;
        const status = (fayda_number && fayda_number.trim() !== '') ? 'Active' : 'Pending';

        const gradeInt = parseInt(class_level);
        const possibleSections = (gradeInt === 9) ? ['A', 'B', 'C'] : (gradeInt === 10) ? ['A', 'B', 'C', 'D'] : ['A', 'B'];

        // Scoped by school_id too — otherwise two schools' Grade 9 headcounts
        // would get mixed together when balancing which section a new
        // student lands in.
        const [stats] = await conn.query(
            'SELECT section, COUNT(*) as count FROM students WHERE school_id = ? AND class_level = ? AND stream = ? GROUP BY section',
            [school_id, class_level, stream]
        );

        let counts = {};
        possibleSections.forEach(s => counts[s] = 0);
        stats.forEach(stat => { if (counts.hasOwnProperty(stat.section)) counts[stat.section] = stat.count; });
        let assignedSection = possibleSections.reduce((a, b) => counts[a] <= counts[b] ? a : b);

        const sql = `INSERT INTO students (student_id, school_id, school_name, first_name, middle_name, last_name, sex, class_level, stream, section, phone_number, fayda_number, status, lms_username, email_address, assigned_computer, security_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await conn.query(sql, [student_id, school_id, school_name, first_name, middle_name, last_name, sex, class_level, stream, assignedSection, phone_number, fayda_number, status, lms_username, email_address, assigned_pc, security_password]);

        await conn.commit();

        res.json({ message: "Registered!", student_id, assignedSection, assigned_pc, security_password: plain_password });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: "Registration failed: " + err.message });
    } finally {
        conn.release();
    }
});

app.post('/api/add-mark', requireAuth, async (req, res) => {
    const { student_id, subject_id, type, score } = req.body;

    if (!student_id || !subject_id) {
        return res.status(400).json({ error: "student_id and subject_id are required" });
    }

    if (!ASSESSMENT_TYPES.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be one of: ${ASSESSMENT_TYPES.join(', ')}` });
    }

    try {
        const term = await getCurrentTerm(req.user.school_id);

        // Scoped to this teacher's own school — otherwise a teacher could
        // submit a student_id belonging to a student at a different school.
        const [studentRows] = await pool.query(
            'SELECT class_level, section, stream FROM students WHERE student_id = ? AND school_id = ?',
            [student_id, req.user.school_id]
        );
        if (studentRows.length === 0) {
            return res.status(404).json({ error: "Student not found" });
        }
        const { class_level, section, stream } = studentRows[0];

        const locked = await isPushedAndLocked(subject_id, class_level, section, stream, term, req.user.school_id);
        if (locked) {
            return res.status(403).json({
                error: `This subject's ${term} report for this section has already been pushed to the homeroom teacher and is locked. No further marks can be entered.`
            });
        }

        await pool.query(
            'INSERT INTO marks (student_id, subject_id, type, score, term, school_id) VALUES (?, ?, ?, ?, ?, ?)',
            [student_id, subject_id, type, score, term, req.user.school_id]
        );
        res.json({ message: "Mark saved successfully!", term });
    } catch (err) {
        console.error("add-mark error:", err);
        res.status(500).json({ error: "Failed to save: " + err.message });
    }
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        // Sanitize the original filename: keep only the extension from it
        // and discard the rest, so path-traversal characters or unusual
        // unicode in a user-supplied filename never reach the filesystem.
        const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, uniqueName);
    }
});

// This single `upload` instance is shared by two very different routes:
//   - /api/teacher/update-avatar expects an image
//   - /api/upload-marks expects a CSV
// Multer's fileFilter only sees the file metadata (mimetype/originalname),
// not which route called it, so we whitelist BOTH acceptable kinds here
// and let each route still validate it actually got what it needed.
const ALLOWED_UPLOAD_MIME_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'text/csv', 'application/vnd.ms-excel' // some browsers send CSV as this
];

const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const isImage = file.mimetype.startsWith('image/');
        const isCsv = ext === '.csv' || ALLOWED_UPLOAD_MIME_TYPES.includes(file.mimetype);

        if (isImage || isCsv) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported file type. Only images (avatar) or .csv (marks) are allowed.'));
        }
    }
});

// Multer's fileFilter errors surface as a generic Express error unless
// each upload route's handler is wrapped to catch them — this small
// wrapper turns "Unsupported file type" into a clean 400 instead of a
// raw 500 / unhandled error.
function handleUploadError(uploadMiddleware) {
    return (req, res, next) => {
        uploadMiddleware(req, res, (err) => {
            if (err) {
                return res.status(400).json({ error: err.message || "Upload failed" });
            }
            next();
        });
    };
}

app.get('/api/student/:id', requireAuth, async (req, res) => {
    try {
        const [results] = await pool.query(
            'SELECT * FROM students WHERE student_id = ? AND school_id = ?',
            [req.params.id, req.user.school_id]
        );
        if (results.length === 0) return res.status(404).json({ error: 'Student not found' });
        res.json(results[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// student_id, subject_id, type, score
app.post('/api/upload-marks', requireAuth, handleUploadError(upload.single('file')), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No CSV file uploaded" });
    }

    // The shared multer filter also allows images (for the avatar route) —
    // this route specifically needs a CSV, so re-check that here.
    if (path.extname(req.file.originalname).toLowerCase() !== '.csv') {
        return res.status(400).json({ error: "File must be a .csv file." });
    }

    try {
        const fs = await import('fs');
        const raw = fs.readFileSync(req.file.path, 'utf8');
        const term = await getCurrentTerm(req.user.school_id);

        // Split into non-empty lines, support both \n and \r\n
        const lines = raw.split(/\r?\n/).filter(line => line.trim() !== '');
        if (lines.length < 2) {
            return res.status(400).json({ error: "CSV is empty or missing a header row" });
        }

        const header = lines[0].split(',').map(h => h.trim().toLowerCase());
        const required = ['student_id', 'subject_id', 'type', 'score'];
        const missing = required.filter(col => !header.includes(col));
        if (missing.length > 0) {
            return res.status(400).json({ error: `CSV header missing column(s): ${missing.join(', ')}` });
        }

        const colIndex = {};
        required.forEach(col => { colIndex[col] = header.indexOf(col); });

        const rows = [];
        const rowErrors = [];

        // Cache lookups so a CSV with many rows for the same student/subject
        // doesn't re-query the DB for every single line.
        const studentSectionCache = new Map(); // student_id -> {class_level, section, stream}
        const lockCache = new Map(); // "subject_id|class_level|section|stream" -> boolean

        for (let i = 1; i < lines.length; i++) {
            const cells = lines[i].split(',').map(c => c.trim());
            const student_id = cells[colIndex.student_id];
            const subject_id = cells[colIndex.subject_id];
            const type = cells[colIndex.type];
            const scoreRaw = cells[colIndex.score];
            const score = parseInt(scoreRaw, 10);

            if (!student_id || !subject_id || !type || isNaN(score)) {
                rowErrors.push(`Row ${i + 1}: invalid or missing data ("${lines[i]}")`);
                continue;
            }
            if (!ASSESSMENT_TYPES.includes(type)) {
                rowErrors.push(`Row ${i + 1}: invalid type "${type}". Must be one of: ${ASSESSMENT_TYPES.join(', ')}`);
                continue;
            }
            if (score < 0 || score > 100) {
                rowErrors.push(`Row ${i + 1}: score ${score} out of range (0-100)`);
                continue;
            }

            // Resolve the student's section (cached) — scoped to this
            // teacher's own school, so a CSV can never add marks for a
            // student belonging to a different school.
            let studentInfo = studentSectionCache.get(student_id);
            if (!studentInfo) {
                const [studentRows] = await pool.query(
                    'SELECT class_level, section, stream FROM students WHERE student_id = ? AND school_id = ?',
                    [student_id, req.user.school_id]
                );
                if (studentRows.length === 0) {
                    rowErrors.push(`Row ${i + 1}: student_id "${student_id}" not found in your school`);
                    continue;
                }
                studentInfo = studentRows[0];
                studentSectionCache.set(student_id, studentInfo);
            }

            // Check the lock (cached per subject+section combo)
            const lockKey = `${subject_id}|${studentInfo.class_level}|${studentInfo.section}|${studentInfo.stream}`;
            let locked = lockCache.get(lockKey);
            if (locked === undefined) {
                locked = await isPushedAndLocked(subject_id, studentInfo.class_level, studentInfo.section, studentInfo.stream, term, req.user.school_id);
                lockCache.set(lockKey, locked);
            }
            if (locked) {
                rowErrors.push(`Row ${i + 1}: subject ${subject_id} for this student's section is locked (already pushed to homeroom for ${term})`);
                continue;
            }

            rows.push([student_id, subject_id, type, score, term, req.user.school_id]);
        }

        if (rows.length > 0) {
            await pool.query(
                'INSERT INTO marks (student_id, subject_id, type, score, term, school_id) VALUES ?',
                [rows]
            );
        }

        res.json({
            message: `Uploaded ${rows.length} mark(s) successfully.` +
                (rowErrors.length > 0 ? ` ${rowErrors.length} row(s) skipped.` : ''),
            inserted: rows.length,
            skipped: rowErrors.length,
            errors: rowErrors
        });

    } catch (err) {
        console.error("Bulk mark upload error:", err);
        res.status(500).json({ error: "Failed to process CSV: " + err.message });
    } finally {
        // Clean up the uploaded temp file regardless of outcome
        if (req.file) {
            try {
                const fs = await import('fs');
                fs.unlinkSync(req.file.path);
            } catch (cleanupErr) {
                console.error("Could not delete temp upload file:", cleanupErr);
            }
        }
    }
});

app.put('/api/update/:id', requireAuth, requireRole('registrar_users'), async (req, res) => {
    try {
        const { first_name, middle_name, last_name, phone_number, fayda_number, sex, class_level, stream } = req.body;
        const finalStatus = (fayda_number && fayda_number.trim() !== '') ? 'Active' : 'Pending';
        const sql = `UPDATE students SET first_name=?, middle_name=?, last_name=?, phone_number=?, fayda_number=?, sex=?, class_level=?, stream=?, status=? WHERE student_id=? AND school_id=?`;
        const [result] = await pool.query(sql, [first_name, middle_name, last_name, phone_number, fayda_number, sex, class_level, stream, finalStatus, req.params.id, req.user.school_id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Student not found in your school." });
        }
        res.sendStatus(200);
    } catch (err) {
        res.status(500).send("Database error: " + err.message);
    }
});

app.put('/api/promote/:id', requireAuth, requireRole('registrar_users'), async (req, res) => {
    try {
        const { class_level, stream } = req.body;
        const [result] = await pool.query(
            'UPDATE students SET class_level = ?, stream = ? WHERE student_id = ? AND school_id = ?',
            [class_level, stream, req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Student not found in your school." });
        }
        res.json({ message: 'Student promoted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/dashboard-data', requireAuth, async (req, res) => {
    try {
        const { stream, class_level, section } = req.query;
        let query = "SELECT * FROM students WHERE school_id = ?";
        let params = [req.user.school_id];
        if (stream && stream !== 'undefined') { query += " AND stream LIKE ?"; params.push('%' + stream + '%'); }
        if (class_level && class_level !== 'undefined') { query += " AND class_level = ?"; params.push(class_level); }
        if (section && section !== 'undefined') { query += " AND section = ?"; params.push(section); }
        const [results] = await pool.query(query, params);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/teacher-access', requireAuth, async (req, res) => {
    try {
        const [assignments] = await pool.query(
            'SELECT class_level, section, subject_id, stream FROM teacher_assignments WHERE teacher_id = ? AND school_id = ?',
            [req.user.user_id, req.user.school_id]
        );
        res.json(assignments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/search-student', requireAuth, async (req, res) => {
    const { query } = req.query;
    try {
        const sql = `SELECT s.first_name, s.last_name, sub.subject_name, m.score, m.term
            FROM students s
            JOIN marks m ON s.student_id = m.student_id
            JOIN subjects sub ON m.subject_id = sub.subject_id
            WHERE (s.first_name LIKE ? OR s.student_id = ?)
              AND s.school_id = ? AND m.school_id = ? AND sub.school_id = ?`;
        const [results] = await pool.query(sql, [`%${query}%`, query, req.user.school_id, req.user.school_id, req.user.school_id]);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/student-progress/:id', requireAuth, async (req, res) => {
    try {
        // Only join subjects that belong to THIS student's stream AND school —
        // matching on stream name alone (without school_id) would otherwise
        // pull in another school's subjects too, since stream names like
        // "Natural Science" aren't unique across schools.
        const sql = `
            SELECT s.first_name, s.middle_name, s.last_name, subj.subject_name,
                MAX(CASE WHEN m.type = 'individual_assignment_1' AND m.term = 'Semester 1' THEN m.score END) as individual_assignment_1_s1,
                MAX(CASE WHEN m.type = 'individual_assignment_1' AND m.term = 'Semester 2' THEN m.score END) as individual_assignment_1_s2,
                MAX(CASE WHEN m.type = 'individual_assignment_2' AND m.term = 'Semester 1' THEN m.score END) as individual_assignment_2_s1,
                MAX(CASE WHEN m.type = 'individual_assignment_2' AND m.term = 'Semester 2' THEN m.score END) as individual_assignment_2_s2,
                MAX(CASE WHEN m.type = 'group_assignment' AND m.term = 'Semester 1' THEN m.score END) as group_assignment_s1,
                MAX(CASE WHEN m.type = 'group_assignment' AND m.term = 'Semester 2' THEN m.score END) as group_assignment_s2,
                MAX(CASE WHEN m.type = 'quiz' AND m.term = 'Semester 1' THEN m.score END) as quiz_s1,
                MAX(CASE WHEN m.type = 'quiz' AND m.term = 'Semester 2' THEN m.score END) as quiz_s2,
                MAX(CASE WHEN m.type = 'midterm' AND m.term = 'Semester 1' THEN m.score END) as midterm_s1,
                MAX(CASE WHEN m.type = 'midterm' AND m.term = 'Semester 2' THEN m.score END) as midterm_s2,
                MAX(CASE WHEN m.type = 'final' AND m.term = 'Semester 1' THEN m.score END) as final_s1,
                MAX(CASE WHEN m.type = 'final' AND m.term = 'Semester 2' THEN m.score END) as final_s2
            FROM students s
            JOIN subjects subj ON subj.stream = s.stream AND subj.school_id = s.school_id
            LEFT JOIN marks m ON subj.subject_id = m.subject_id AND m.student_id = s.student_id AND m.school_id = s.school_id
            WHERE s.student_id = ? AND s.school_id = ?
            GROUP BY s.student_id, subj.subject_id, s.first_name, s.middle_name, s.last_name, subj.subject_name
        `;
        const [rows] = await pool.query(sql, [req.params.id, req.user.school_id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/students', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM students WHERE school_id = ?', [req.user.school_id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Database query failed" });
    }
});

app.get('/api/student-stats', requireAuth, async (req, res) => {
    const { class_level, section, stream } = req.query;
    const isTeacher = req.user.role === 'teachers';

    try {
        // Teachers get a count scoped to their own assignments; other roles
        // (registrar/admin) get a school-wide count. Either way, school_id
        // is always enforced — never trust a client-supplied teacher_id,
        // and never match class_level/section/stream alone, since those
        // labels (e.g. "Grade 10 Section A") aren't unique across schools.
        let sql, params;

        if (isTeacher) {
            sql = `
                SELECT COUNT(DISTINCT s.student_id) as total,
                       SUM(CASE WHEN s.sex = 'Female' THEN 1 ELSE 0 END) as female,
                       SUM(CASE WHEN s.sex = 'Male' THEN 1 ELSE 0 END) as male
                FROM students s
                INNER JOIN teacher_assignments ta
                    ON s.class_level = ta.class_level
                    AND s.section = ta.section
                    AND s.stream = ta.stream
                    AND s.school_id = ta.school_id
                WHERE ta.teacher_id = ? AND ta.school_id = ?
            `;
            params = [req.user.user_id, req.user.school_id];

            if (class_level) { sql += ' AND s.class_level = ?'; params.push(class_level); }
            if (section) { sql += ' AND s.section = ?'; params.push(section); }
            if (stream) { sql += ' AND s.stream = ?'; params.push(stream); }
        } else {
            sql = `SELECT COUNT(*) as total, SUM(CASE WHEN sex = 'Female' THEN 1 ELSE 0 END) as female, SUM(CASE WHEN sex = 'Male' THEN 1 ELSE 0 END) as male FROM students WHERE school_id = ?`;
            params = [req.user.school_id];
        }

        const [stats] = await pool.query(sql, params);
        res.json({
            total: stats[0].total || 0,
            female: stats[0].female || 0,
            male: stats[0].male || 0
        });
    } catch (err) {
        console.error("student-stats error:", err);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

app.get('/api/teacher/subjects', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT DISTINCT s.subject_id, s.subject_name
             FROM subjects s
             JOIN teacher_assignments ta ON s.subject_id = ta.subject_id AND s.school_id = ta.school_id
             WHERE ta.teacher_id = ? AND ta.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Could not fetch assigned subjects" });
    }
});

app.get('/api/student-marks/:student_id', requireAuth, async (req, res) => {
    try {
        const [marks] = await pool.query(
            `SELECT s.subject_name, m.score, m.type, m.term
             FROM marks m
             JOIN subjects s ON m.subject_id = s.subject_id AND s.school_id = m.school_id
             WHERE m.student_id = ? AND m.school_id = ?`,
            [req.params.student_id, req.user.school_id]
        );
        res.json(marks);
    } catch (err) {
        res.status(500).json({ error: "Could not fetch marks" });
    }
});

app.get('/api/subjects', requireAuth, async (req, res) => {
    const { stream } = req.query;

    try {
        let query = 'SELECT subject_id, subject_name, stream FROM subjects WHERE school_id = ?';
        let params = [req.user.school_id];

        if (stream) {
            query += ' AND stream = ?';
            params.push(stream);
        }

        const [rows] = await pool.query(query, params);
        res.json(rows);

    } catch (err) {
        console.error("Subject Query Error:", err);
        res.status(500).json({ error: "Could not fetch subjects" });
    }
});
// Teacher notification/security preferences — in-memory only (not persisted).
// GET: returns the saved preference map for a teacher (empty object if none yet)
app.get('/api/teacher/preferences', requireAuth, (req, res) => {
    res.json(teacherPreferences.get(req.user.user_id) || {});
});

// POST: saves/updates a single preference for a teacher
app.post('/api/teacher/update-preferences', requireAuth, (req, res) => {
    const { preference, value } = req.body;

    if (!preference) {
        return res.status(400).json({ error: "preference is required" });
    }

    const current = teacherPreferences.get(req.user.user_id) || {};
    current[preference] = value;
    teacherPreferences.set(req.user.user_id, current);

    res.json({ message: "Preference saved (in-memory only, resets on server restart)", preferences: current });
});

// Add this to your "API Endpoints" section in server.js
app.get('/api/teacher/profile', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM teachers WHERE teacher_id = ? AND school_id = ?',
            [req.user.user_id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Teacher not found" });

        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// 1. Route to handle Profile Updates
app.post('/api/teacher/update-profile', requireAuth, async (req, res) => {
    const { contact_number } = req.body;

    try {
        const [result] = await pool.query(
            'UPDATE teachers SET contact_number = ? WHERE teacher_id = ? AND school_id = ?',
            [contact_number, req.user.user_id, req.user.school_id]
        );
        res.json({ message: "Profile updated successfully!" });
    } catch (err) {
        console.error("Update error:", err);
        res.status(500).json({ error: "Database update failed" });
    }
});

// 2. Route to handle Avatar Upload
app.post('/api/teacher/update-avatar', requireAuth, handleUploadError(upload.single('avatar')), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded" });
        }

        // fileFilter already rejected non-image/non-csv files, but since
        // this route specifically needs an IMAGE (not a CSV), double-check
        // here too — someone could otherwise upload a valid CSV as their
        // "avatar" and it would pass the shared filter.
        if (!req.file.mimetype.startsWith('image/')) {
            return res.status(400).json({ error: "Avatar must be an image file (JPEG, PNG, GIF, or WEBP)." });
        }

        const filePath = `/uploads/${req.file.filename}`;

        await pool.query(
            'UPDATE teachers SET avatar_url = ? WHERE teacher_id = ? AND school_id = ?',
            [filePath, req.user.user_id, req.user.school_id]
        );

        res.json({ new_avatar_url: filePath });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Upload failed" });
    }
});
app.post('/api/teacher/update-password', requireAuth, async (req, res) => {
    const { currentPass, newPass } = req.body;

    try {
        const [rows] = await pool.query(
            'SELECT security_password FROM teachers WHERE teacher_id = ? AND school_id = ?',
            [req.user.user_id, req.user.school_id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Teacher not found" });
        }

        const stored = rows[0].security_password;

        const match = await bcrypt.compare(currentPass, stored);

        if (!match) {
            return res.status(401).json({ error: "Current password incorrect" });
        }

        const hashed = await bcrypt.hash(newPass, 10);

        await pool.query(
            'UPDATE teachers SET security_password = ? WHERE teacher_id = ? AND school_id = ?',
            [hashed, req.user.user_id, req.user.school_id]
        );

        res.json({ message: "Password updated successfully" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Password update failed" });
    }
});
app.get('/api/teacher/eligible-subjects', requireAuth, async (req, res) => {
    const { stream } = req.query;

    try {
        // This query:
        const sql = `
            SELECT DISTINCT s.subject_id, s.subject_name 
            FROM subjects s
            INNER JOIN teacher_assignments ta ON s.subject_id = ta.subject_id AND s.school_id = ta.school_id
            WHERE s.stream = ? AND ta.teacher_id = ? AND s.school_id = ?
        `;
        const [rows] = await pool.query(sql, [stream, req.user.user_id, req.user.school_id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch eligible subjects" });
    }
});
// Ensure these routes are in server.js
app.get('/api/teacher/full-profile', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT t.full_name, t.teacher_id, t.contact_number, t.email, t.additional_role,
                    ta.stream, s.subject_name
             FROM teachers t
             LEFT JOIN teacher_assignments ta ON t.teacher_id = ta.teacher_id AND t.school_id = ta.school_id
             LEFT JOIN subjects s ON ta.subject_id = s.subject_id AND ta.school_id = s.school_id
             WHERE t.teacher_id = ? AND t.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Teacher not found" });
        res.json({
            full_name: rows[0].full_name,
            teacher_id: rows[0].teacher_id,
            contact_number: rows[0].contact_number,
            email: rows[0].email,
            additional_role: rows[0].additional_role || null,
            streams: [...new Set(rows.map(r => r.stream).filter(Boolean))],
            subjects: [...new Set(rows.map(r => r.subject_name).filter(Boolean))]
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// "My Performance" widget data: average student score per subject for
// both terms (so Semester 1 and Semester 2 can be shown side by side),
// plus an overall completion percentage across this teacher's conduct
// checklist (how much of their required grading they've actually done).
app.get('/api/teacher/performance', requireAuth, async (req, res) => {
    try {
        const currentTerm = await getCurrentTerm(req.user.school_id);
        const semester2Started = currentTerm === 'Semester 2';

        const [assignments] = await pool.query(
            `SELECT DISTINCT ta.subject_id, s.subject_name, ta.class_level, ta.section, ta.stream
             FROM teacher_assignments ta
             JOIN subjects s ON s.subject_id = ta.subject_id AND s.school_id = ta.school_id
             WHERE ta.teacher_id = ? AND ta.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );

        // 2. Average score per subject per term, across ALL sections this
        // teacher teaches that subject in (a subject can span >1 section).
        const subjectIds = [...new Set(assignments.map(a => a.subject_id))];
        const subjectAverages = {}; // subject_id -> { 'Semester 1': avg, 'Semester 2': avg }

        for (const subject_id of subjectIds) {
            const [avgRows] = await pool.query(
                `SELECT term, AVG(score) as avg_score
                 FROM marks
                 WHERE subject_id = ? AND school_id = ?
                 GROUP BY term`,
                [subject_id, req.user.school_id]
            );
            subjectAverages[subject_id] = {};
            avgRows.forEach(row => {
                subjectAverages[subject_id][row.term] = Math.round(Number(row.avg_score) * 100) / 100;
            });
        }

        const subjectNameById = {};
        assignments.forEach(a => { subjectNameById[a.subject_id] = a.subject_name; });

        const chartData = subjectIds.map(subject_id => ({
            subject_id,
            subject_name: subjectNameById[subject_id],
            semester_1: subjectAverages[subject_id]['Semester 1'] ?? null,
            semester_2: subjectAverages[subject_id]['Semester 2'] ?? null
        }));

        // 3. Overall conduct completion % across every (subject, section,
        // assessment type) this teacher is responsible for, CURRENT term only.
        let totalChecks = 0;
        let completedChecks = 0;

        for (const a of assignments) {
            // school_id added here — without it, this would count students
            // from ANY school sharing the same class_level/section/stream
            // labels (e.g. "Grade 10 Section A"), silently inflating or
            // corrupting this teacher's completion percentage.
            const [[{ total }]] = await pool.query(
                `SELECT COUNT(*) as total FROM students WHERE class_level = ? AND section = ? AND stream = ? AND school_id = ?`,
                [a.class_level, a.section, a.stream, req.user.school_id]
            );
            if (total === 0) continue;

            const [markCounts] = await pool.query(
                `SELECT m.type, COUNT(DISTINCT m.student_id) as marked
                 FROM marks m
                 JOIN students st ON st.student_id = m.student_id AND st.school_id = m.school_id
                 WHERE m.subject_id = ? AND m.term = ? AND m.school_id = ?
                   AND st.class_level = ? AND st.section = ? AND st.stream = ?
                 GROUP BY m.type`,
                [a.subject_id, currentTerm, req.user.school_id, a.class_level, a.section, a.stream]
            );
            const markedByType = {};
            markCounts.forEach(row => { markedByType[row.type] = row.marked; });

            ASSESSMENT_TYPES.forEach(type => {
                totalChecks += 1;
                const marked = markedByType[type] || 0;
                if (total > 0 && (marked / total) * 100 >= 50) completedChecks += 1;
            });
        }

        const completionPercent = totalChecks > 0 ? Math.round((completedChecks / totalChecks) * 100) : 0;

        res.json({
            current_term: currentTerm,
            semester_2_started: semester2Started,
            chart_data: chartData,
            completion: {
                completed: completedChecks,
                total: totalChecks,
                percent: completionPercent
            }
        });
    } catch (err) {
        console.error("performance error:", err);
        res.status(500).json({ error: "Could not load performance data" });
    }
});

// --- Push to Homeroom ---

// For the Reports page: shows a subject teacher every (subject, section)
// they're assigned to, whether it's been pushed for the CURRENT term yet,
// and if so, when and by whom (always themselves, but useful to confirm).
app.get('/api/teacher/push-status', requireAuth, async (req, res) => {
    try {
        const term = await getCurrentTerm(req.user.school_id);
        const [assignments] = await pool.query(
            `SELECT ta.class_level, ta.section, ta.stream, ta.subject_id, s.subject_name
             FROM teacher_assignments ta
             JOIN subjects s ON s.subject_id = ta.subject_id AND s.school_id = ta.school_id
             WHERE ta.teacher_id = ? AND ta.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );

        const results = await Promise.all(assignments.map(async (a) => {
            const [pushRows] = await pool.query(
                `SELECT push_id, pushed_at FROM pushed_reports
                 WHERE subject_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ? AND school_id = ?`,
                [a.subject_id, a.class_level, a.section, a.stream, term, req.user.school_id]
            );
            return {
                class_level: a.class_level,
                section: a.section,
                stream: a.stream,
                subject_id: a.subject_id,
                subject_name: a.subject_name,
                term,
                pushed: pushRows.length > 0,
                pushed_at: pushRows.length > 0 ? pushRows[0].pushed_at : null
            };
        }));

        res.json(results);
    } catch (err) {
        console.error("push-status error:", err);
        res.status(500).json({ error: "Could not load push status" });
    }
});

// The actual push: sums all 6 assessment scores per student for this
// subject+section+term, snapshots those totals, and locks the combo so
// no further marks can be entered for it. This cannot be undone via the
// API on purpose — pushing is a deliberate, final action.
app.post('/api/teacher/push-report', requireAuth, async (req, res) => {
    const { subject_id, class_level, section, stream } = req.body;

    if (!subject_id || !class_level || !section || !stream) {
        return res.status(400).json({ error: "subject_id, class_level, section, and stream are required" });
    }

    try {
        const term = await getCurrentTerm(req.user.school_id);

        // Confirm this teacher actually teaches this subject+section —
        // don't let anyone push a report for a class they don't own.
        const [ownsAssignment] = await pool.query(
            `SELECT 1 FROM teacher_assignments
             WHERE teacher_id = ? AND subject_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?`,
            [req.user.user_id, subject_id, class_level, section, stream, req.user.school_id]
        );
        if (ownsAssignment.length === 0) {
            return res.status(403).json({ error: "You are not assigned to teach this subject for this section." });
        }

        const alreadyPushed = await isPushedAndLocked(subject_id, class_level, section, stream, term, req.user.school_id);
        if (alreadyPushed) {
            return res.status(409).json({ error: `This subject's ${term} report for this section has already been pushed and locked.` });
        }

        // Sum all 6 assessment types per student for this subject+section+term
        const [totals] = await pool.query(
            `SELECT st.student_id, SUM(m.score) as total_score
             FROM students st
             JOIN marks m ON m.student_id = st.student_id AND m.school_id = st.school_id
             WHERE m.subject_id = ? AND m.term = ? AND m.school_id = ?
               AND st.class_level = ? AND st.section = ? AND st.stream = ?
             GROUP BY st.student_id`,
            [subject_id, term, req.user.school_id, class_level, section, stream]
        );

        if (totals.length === 0) {
            return res.status(400).json({ error: "No marks have been entered yet for this subject/section/term. Nothing to push." });
        }

        const [insertResult] = await pool.query(
            `INSERT INTO pushed_reports (subject_id, class_level, section, stream, term, pushed_by, school_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [subject_id, class_level, section, stream, term, req.user.user_id, req.user.school_id]
        );
        const push_id = insertResult.insertId;

        const scoreRows = totals.map(t => [push_id, t.student_id, t.total_score, req.user.school_id]);
        await pool.query(
            'INSERT INTO pushed_report_scores (push_id, student_id, total_score, school_id) VALUES ?',
            [scoreRows]
        );

        res.json({
            message: `Pushed ${term} report to homeroom for ${totals.length} student(s). This subject is now locked for this section/term.`,
            push_id,
            students_included: totals.length
        });
    } catch (err) {
        console.error("push-report error:", err);
        res.status(500).json({ error: "Could not push report: " + err.message });
    }
});

// --- Homeroom Reports ---

// Identifies which section (if any) this teacher is homeroom for.
app.get('/api/teacher/homeroom-info', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT homeroom_class_level, homeroom_section, homeroom_stream FROM teachers WHERE teacher_id = ? AND school_id = ?',
            [req.user.user_id, req.user.school_id]
        );
        if (rows.length === 0 || !rows[0].homeroom_section) {
            return res.json({ is_homeroom: false });
        }
        res.json({
            is_homeroom: true,
            class_level: rows[0].homeroom_class_level,
            section: rows[0].homeroom_section,
            stream: rows[0].homeroom_stream
        });
    } catch (err) {
        console.error("homeroom-info error:", err);
        res.status(500).json({ error: "Could not load homeroom info" });
    }
});

// Single-student full report card: one row per subject that has been
// pushed (for any term), showing Semester 1 total, Semester 2 total, and
// the year average of the two. Subjects not yet pushed for a given term
// simply don't have that term's column filled in.
app.get('/api/homeroom/student-report/:student_id', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT s.subject_name, pr.term, prs.total_score
             FROM pushed_report_scores prs
             JOIN pushed_reports pr ON pr.push_id = prs.push_id AND pr.school_id = prs.school_id
             JOIN subjects s ON s.subject_id = pr.subject_id AND s.school_id = pr.school_id
             WHERE prs.student_id = ? AND prs.school_id = ?
             ORDER BY s.subject_name, pr.term`,
            [req.params.student_id, req.user.school_id]
        );

        // Reshape into { subject_name: { 'Semester 1': x, 'Semester 2': y } }
        const bySubject = {};
        rows.forEach(row => {
            if (!bySubject[row.subject_name]) bySubject[row.subject_name] = {};
            bySubject[row.subject_name][row.term] = Number(row.total_score);
        });

        const report = Object.keys(bySubject).sort().map(subject_name => {
            const s1 = bySubject[subject_name]['Semester 1'];
            const s2 = bySubject[subject_name]['Semester 2'];
            const bothPresent = s1 != null && s2 != null;
            return {
                subject_name,
                semester_1: s1 != null ? s1 : null,
                semester_2: s2 != null ? s2 : null,
                year_average: bothPresent ? Math.round(((s1 + s2) / 2) * 100) / 100 : null
            };
        });

        res.json(report);
    } catch (err) {
        console.error("student-report error:", err);
        res.status(500).json({ error: "Could not load student report" });
    }
});

// Whole-section table for principal reporting / CSV export: rows = every
// student in the homeroom teacher's section, columns = every subject that
// has EVER been pushed for that section (across both terms), each split
// into S1 / S2 / Year Avg. Subjects not yet pushed are simply absent —
// per your earlier answer, only pushed subjects appear, nothing blank-padded
// for subjects that were never pushed at all. (A subject pushed for only
// one term DOES show, with the other term's cell empty.)
app.get('/api/homeroom/section-report', requireAuth, async (req, res) => {
    const { class_level, section, stream } = req.query;
    if (!class_level || !section || !stream) {
        return res.status(400).json({ error: "class_level, section, and stream are required" });
    }

    try {
        // Verify the caller is actually the homeroom teacher for THIS
        // section — otherwise any logged-in teacher could pull any other
        // section's report just by knowing the right query params.
        const [homeroomCheck] = await pool.query(
            `SELECT 1 FROM teachers
             WHERE teacher_id = ? AND school_id = ?
               AND homeroom_class_level = ? AND homeroom_section = ? AND homeroom_stream = ?`,
            [req.user.user_id, req.user.school_id, class_level, section, stream]
        );
        if (homeroomCheck.length === 0) {
            return res.status(403).json({ error: "You are not the homeroom teacher for this section." });
        }

        const [students] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name
             FROM students
             WHERE class_level = ? AND section = ? AND stream = ? AND school_id = ?
             ORDER BY first_name, last_name`,
            [class_level, section, stream, req.user.school_id]
        );

        const [scoreRows] = await pool.query(
            `SELECT prs.student_id, s.subject_name, pr.term, prs.total_score
             FROM pushed_report_scores prs
             JOIN pushed_reports pr ON pr.push_id = prs.push_id AND pr.school_id = prs.school_id
             JOIN subjects s ON s.subject_id = pr.subject_id AND s.school_id = pr.school_id
             WHERE pr.class_level = ? AND pr.section = ? AND pr.stream = ? AND pr.school_id = ?`,
            [class_level, section, stream, req.user.school_id]
        );

        // Collect the distinct set of subjects that have EVER been pushed
        // for this section, so every student row has the same columns.
        const subjectNames = [...new Set(scoreRows.map(r => r.subject_name))].sort();

        // scoresByStudent[student_id][subject_name][term] = total
        const scoresByStudent = {};
        scoreRows.forEach(row => {
            if (!scoresByStudent[row.student_id]) scoresByStudent[row.student_id] = {};
            if (!scoresByStudent[row.student_id][row.subject_name]) {
                scoresByStudent[row.student_id][row.subject_name] = {};
            }
            scoresByStudent[row.student_id][row.subject_name][row.term] = Number(row.total_score);
        });

        const report = students.map(student => {
            const subjects = {};
            subjectNames.forEach(name => {
                const entry = (scoresByStudent[student.student_id] || {})[name] || {};
                const s1 = entry['Semester 1'];
                const s2 = entry['Semester 2'];
                const bothPresent = s1 != null && s2 != null;
                subjects[name] = {
                    semester_1: s1 != null ? s1 : null,
                    semester_2: s2 != null ? s2 : null,
                    year_average: bothPresent ? Math.round(((s1 + s2) / 2) * 100) / 100 : null
                };
            });
            return {
                student_id: student.student_id,
                full_name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' '),
                subjects
            };
        });

        res.json({ subject_columns: subjectNames, students: report });
    } catch (err) {
        console.error("section-report error:", err);
        res.status(500).json({ error: "Could not load section report" });
    }
});

// --- Textbook Distribution ---
// No school-year selector exists anywhere yet, so this defaults to the
// current calendar year. Revisit once a real academic-year concept is
function getSchoolYear() {
    return new Date().getFullYear().toString();
}

// Shared by every /api/homeroom/textbooks/* route: confirms the caller is
// actually a homeroom teacher and returns which section they're homeroom
// for. Returns null if they aren't one (caller should respond 403).
async function getHomeroomSectionOrNull(teacher_id, school_id) {
    const [teacherRows] = await pool.query(
        'SELECT homeroom_class_level, homeroom_section, homeroom_stream FROM teachers WHERE teacher_id = ? AND school_id = ?',
        [teacher_id, school_id]
    );
    if (teacherRows.length === 0 || !teacherRows[0].homeroom_section) {
        return null;
    }
    return {
        class_level: teacherRows[0].homeroom_class_level,
        section: teacherRows[0].homeroom_section,
        stream: teacherRows[0].homeroom_stream
    };
}

// Homeroom teacher's grid: every student in their section x every subject
// in that section's stream, with issued/returned/lost status per cell.
// Restricted to homeroom teachers only — checked via teachers.homeroom_*.
app.get('/api/homeroom/textbooks', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher, so textbook distribution isn't available to you." });
        }
        const { class_level, section, stream } = homeroom;
        const school_year = getSchoolYear();

        const [students] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name
             FROM students WHERE class_level = ? AND section = ? AND stream = ? AND school_id = ?
             ORDER BY first_name, last_name`,
            [class_level, section, stream, req.user.school_id]
        );
        const [subjects] = await pool.query(
            'SELECT subject_id, subject_name FROM subjects WHERE stream = ? AND school_id = ? ORDER BY subject_name',
            [stream, req.user.school_id]
        );
        const [distributions] = await pool.query(
            `SELECT student_id, subject_id, status, issued_at, returned_at, lost_at FROM textbook_distributions
             WHERE school_year = ? AND school_id = ? AND student_id IN (
                SELECT student_id FROM students WHERE class_level = ? AND section = ? AND stream = ? AND school_id = ?
             )`,
            [school_year, req.user.school_id, class_level, section, stream, req.user.school_id]
        );

        const distroMap = {}; // "student_id|subject_id" -> {status, issued_at, returned_at, lost_at}
        distributions.forEach(d => {
            distroMap[`${d.student_id}|${d.subject_id}`] = {
                status: d.status,
                issued_at: d.issued_at,
                returned_at: d.returned_at,
                lost_at: d.lost_at
            };
        });

        const report = students.map(student => {
            const books = subjects.map(subj => {
                const record = distroMap[`${student.student_id}|${subj.subject_id}`];
                return {
                    subject_id: subj.subject_id,
                    subject_name: subj.subject_name,
                    issued: !!record,
                    // status is only meaningful once a record exists; with
                    // no record at all the book hasn't been issued yet.
                    status: record ? record.status : null,
                    issued_at: record ? record.issued_at : null,
                    returned: !!(record && record.status === 'returned'),
                    returned_at: record ? record.returned_at : null,
                    lost: !!(record && record.status === 'lost'),
                    lost_at: record ? record.lost_at : null
                };
            });
            return {
                student_id: student.student_id,
                full_name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' '),
                books
            };
        });

        res.json({
            class_level, section, stream, school_year,
            subjects: subjects.map(s => ({ subject_id: s.subject_id, subject_name: s.subject_name })),
            students: report
        });
    } catch (err) {
        console.error("homeroom textbooks error:", err);
        res.status(500).json({ error: "Could not load textbook distribution data" });
    }
});

// teacher — verified by checking the student is actually in that teacher's
// homeroom section before allowing the insert.
app.post('/api/homeroom/textbooks/issue', requireAuth, async (req, res) => {
    const { student_id, subject_id } = req.body;
    if (!student_id || !subject_id) {
        return res.status(400).json({ error: "student_id and subject_id are required" });
    }

    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }

        const [studentCheck] = await pool.query(
            'SELECT 1 FROM students WHERE student_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?',
            [student_id, homeroom.class_level, homeroom.section, homeroom.stream, req.user.school_id]
        );
        if (studentCheck.length === 0) {
            return res.status(403).json({ error: "This student is not in your homeroom section." });
        }

        const school_year = getSchoolYear();
        await pool.query(
            `INSERT INTO textbook_distributions (student_id, subject_id, issued_by, school_year, school_id, status)
             VALUES (?, ?, ?, ?, ?, 'issued')`,
            [student_id, subject_id, req.user.user_id, school_year, req.user.school_id]
        );

        res.json({ message: "Textbook issued." });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: "This student has already been issued this subject's textbook this year." });
        }
        console.error("issue textbook error:", err);
        res.status(500).json({ error: "Could not issue textbook" });
    }
});

// Mark a previously issued textbook as returned.
app.post('/api/homeroom/textbooks/return', requireAuth, async (req, res) => {
    const { student_id, subject_id } = req.body;
    if (!student_id || !subject_id) {
        return res.status(400).json({ error: "student_id and subject_id are required" });
    }

    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }

        const [studentCheck] = await pool.query(
            'SELECT 1 FROM students WHERE student_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?',
            [student_id, homeroom.class_level, homeroom.section, homeroom.stream, req.user.school_id]
        );
        if (studentCheck.length === 0) {
            return res.status(403).json({ error: "This student is not in your homeroom section." });
        }

        const school_year = getSchoolYear();
        // Only moves a book OUT of 'issued' — a book already marked 'lost'
        // can't be silently flipped to 'returned' through this route. If a
        // "lost" book is physically handed back later, that's a deliberate
        // separate action (re-issue, or a future "undo lost" route), not an
        // accidental side effect of clicking the wrong button.
        const [result] = await pool.query(
            `UPDATE textbook_distributions SET status = 'returned', returned_at = NOW()
             WHERE student_id = ? AND subject_id = ? AND school_year = ? AND school_id = ? AND status = 'issued'`,
            [student_id, subject_id, school_year, req.user.school_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "No active (issued, unreturned) distribution found for this student/subject." });
        }

        res.json({ message: "Textbook marked as returned." });
    } catch (err) {
        console.error("return textbook error:", err);
        res.status(500).json({ error: "Could not mark textbook as returned" });
    }
});

// Mark a previously issued textbook as lost. Separate from "returned" —
// this is for books that are gone for good (damaged beyond use, misplaced,
// etc.), not books that have come back to the homeroom teacher.
app.post('/api/homeroom/textbooks/lost', requireAuth, async (req, res) => {
    const { student_id, subject_id } = req.body;
    if (!student_id || !subject_id) {
        return res.status(400).json({ error: "student_id and subject_id are required" });
    }

    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }

        const [studentCheck] = await pool.query(
            'SELECT 1 FROM students WHERE student_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?',
            [student_id, homeroom.class_level, homeroom.section, homeroom.stream, req.user.school_id]
        );
        if (studentCheck.length === 0) {
            return res.status(403).json({ error: "This student is not in your homeroom section." });
        }

        const school_year = getSchoolYear();
        const [result] = await pool.query(
            `UPDATE textbook_distributions
             SET status = 'lost', lost_at = NOW(), lost_reported_by = ?
             WHERE student_id = ? AND subject_id = ? AND school_year = ? AND school_id = ? AND status = 'issued'`,
            [req.user.user_id, student_id, subject_id, school_year, req.user.school_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "No active (issued, unreturned) distribution found for this student/subject." });
        }

        res.json({ message: "Textbook marked as lost." });
    } catch (err) {
        console.error("lost textbook error:", err);
        res.status(500).json({ error: "Could not mark textbook as lost" });
    }
});

// Undo a "lost" mark, putting the book back to "issued" — for when a
// homeroom teacher clicks Lost by mistake. Blocked once this section's
// textbook report has already been pushed to Admin VP for the year:
// the push stores a point-in-time snapshot (counts), not a live reference,
// so quietly changing a book's status afterward would leave the live grid
// and the report Admin VP already received saying two different things.
app.post('/api/homeroom/textbooks/undo-lost', requireAuth, async (req, res) => {
    const { student_id, subject_id } = req.body;
    if (!student_id || !subject_id) {
        return res.status(400).json({ error: "student_id and subject_id are required" });
    }

    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }
        const { class_level, section, stream } = homeroom;

        const [studentCheck] = await pool.query(
            'SELECT 1 FROM students WHERE student_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?',
            [student_id, class_level, section, stream, req.user.school_id]
        );
        if (studentCheck.length === 0) {
            return res.status(403).json({ error: "This student is not in your homeroom section." });
        }

        const school_year = getSchoolYear();

        const [existingPush] = await pool.query(
            'SELECT push_id FROM pushed_textbook_reports WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_year = ?',
            [req.user.school_id, class_level, section, stream, school_year]
        );
        if (existingPush.length > 0) {
            return res.status(409).json({ error: "This section's textbook report has already been pushed to Admin VP — Lost status can no longer be changed for this school year. Contact an administrator if this needs correcting." });
        }

        const [result] = await pool.query(
            `UPDATE textbook_distributions
             SET status = 'issued', lost_at = NULL, lost_reported_by = NULL
             WHERE student_id = ? AND subject_id = ? AND school_year = ? AND school_id = ? AND status = 'lost'`,
            [student_id, subject_id, school_year, req.user.school_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "No book currently marked Lost was found for this student/subject." });
        }

        res.json({ message: "Lost status undone — textbook is now marked Issued again." });
    } catch (err) {
        console.error("undo-lost textbook error:", err);
        res.status(500).json({ error: "Could not undo lost status" });
    }
});

// Status check before pushing: tells the frontend exactly where things
// stand (total slots, how many are returned/lost/still outstanding, and
// the percentage resolved) without actually pushing anything yet. The
// frontend uses this to decide whether to show "Push" as enabled, or show
// the 90% blocker with specifics on what's still missing.
app.get('/api/homeroom/textbooks/push-status', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }
        const { class_level, section, stream } = homeroom;
        const school_year = getSchoolYear();

        const summary = await getTextbookPushSummary(req.user.school_id, class_level, section, stream, school_year);

        const [alreadyPushed] = await pool.query(
            'SELECT push_id, pushed_at FROM pushed_textbook_reports WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_year = ?',
            [req.user.school_id, class_level, section, stream, school_year]
        );

        res.json({
            ...summary,
            already_pushed: alreadyPushed.length > 0,
            pushed_at: alreadyPushed.length > 0 ? alreadyPushed[0].pushed_at : null
        });
    } catch (err) {
        console.error("textbook push-status error:", err);
        res.status(500).json({ error: "Could not load textbook push status" });
    }
});

// Computes: total book slots (students x subjects in this section), how
// many are returned, how many are lost, how many are still just "issued"
// that was never issued in the first place still counts as an outstanding
// slot, since "not even handed out yet" is not closer to resolved than
// "handed out and not yet back."
async function getTextbookPushSummary(school_id, class_level, section, stream, school_year) {
    // Count only actual issued slots — students who never received any book
    // are excluded so they don't drag the percentage down.
    const [[{ total_slots }]] = await pool.query(
        `SELECT COUNT(*) as total_slots
         FROM textbook_distributions td
         JOIN students st ON st.student_id = td.student_id AND st.school_id = td.school_id
         JOIN subjects sub ON sub.subject_id = td.subject_id AND sub.school_id = td.school_id
         WHERE st.class_level = ? AND st.section = ? AND st.stream = ? AND sub.stream = ?
           AND td.school_id = ? AND td.school_year = ?`,
        [class_level, section, stream, stream, school_id, school_year]
    );

    const [[counts]] = await pool.query(
        `SELECT
            SUM(CASE WHEN td.status = 'returned' THEN 1 ELSE 0 END) as returned_count,
            SUM(CASE WHEN td.status = 'lost' THEN 1 ELSE 0 END) as lost_count
         FROM textbook_distributions td
         JOIN students st ON st.student_id = td.student_id AND st.school_id = td.school_id
         JOIN subjects sub ON sub.subject_id = td.subject_id AND sub.school_id = td.school_id
         WHERE st.class_level = ? AND st.section = ? AND st.stream = ? AND sub.stream = ?
           AND td.school_id = ? AND td.school_year = ?`,
        [class_level, section, stream, stream, school_id, school_year]
    );

    const returned_count = Number(counts.returned_count) || 0;
    const lost_count = Number(counts.lost_count) || 0;
    const resolved_count = returned_count + lost_count;
    const outstanding_count = total_slots - resolved_count;
    const percent_resolved = total_slots > 0 ? (resolved_count / total_slots) * 100 : 100;

    return {
        class_level, section, stream, school_year,
        total_slots, returned_count, lost_count, resolved_count, outstanding_count,
        percent_resolved: Math.round(percent_resolved * 10) / 10
    };
}

// The actual push to Admin VP. Blocked unless at least 90% of book
// slots are resolved (returned or lost) — anything still sitting as
// "issued" (or never issued) below that threshold means too many students
// are unaccounted for to call the section's textbook reconciliation done.
app.post('/api/homeroom/textbooks/push-report', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }
        const { class_level, section, stream } = homeroom;
        const school_year = getSchoolYear();

        const [existingPush] = await pool.query(
            'SELECT push_id FROM pushed_textbook_reports WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_year = ?',
            [req.user.school_id, class_level, section, stream, school_year]
        );
        if (existingPush.length > 0) {
            return res.status(409).json({ error: "This section's textbook report has already been pushed to Admin VP for this school year." });
        }

        const summary = await getTextbookPushSummary(req.user.school_id, class_level, section, stream, school_year);

        if (summary.total_slots === 0) {
            return res.status(400).json({
                error: "There are no students or no subjects configured for this section/stream yet, so there's nothing to push.",
                ...summary
            });
        }

        const PUSH_THRESHOLD_PERCENT = 90;
        if (summary.percent_resolved < PUSH_THRESHOLD_PERCENT) {
            return res.status(400).json({
                error: `Only ${summary.percent_resolved}% of textbooks are marked Returned or Lost. At least ${PUSH_THRESHOLD_PERCENT}% must be resolved before pushing to Admin VP. ${summary.outstanding_count} of ${summary.total_slots} book slot(s) are still outstanding.`,
                ...summary
            });
        }

        const [insertResult] = await pool.query(
            `INSERT INTO pushed_textbook_reports
                (school_id, class_level, section, stream, school_year, pushed_by, total_slots, returned_count, lost_count, outstanding_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.school_id, class_level, section, stream, school_year, req.user.user_id,
             summary.total_slots, summary.returned_count, summary.lost_count, summary.outstanding_count]
        );

        res.json({
            message: `Pushed to Admin VP: ${summary.returned_count} returned, ${summary.lost_count} lost, ${summary.outstanding_count} still outstanding out of ${summary.total_slots} total.`,
            push_id: insertResult.insertId,
            ...summary
        });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: "This section's textbook report has already been pushed to Admin VP for this school year." });
        }
        console.error("textbook push-report error:", err);
        res.status(500).json({ error: "Could not push textbook report: " + err.message });
    }
});

// --- Push compiled section marks to Academic VP ---
// Separate from the textbook push (which goes to Admin VP) — this is the
// homeroom teacher forwarding the section's compiled marks once every
// subject for this stream has been pushed by its own subject teacher.
// Requires ALL subjects pushed (100%), not a partial threshold like the
// textbook push.

// Computes: every subject in this stream, and whether each has been
// pushed (by its own subject teacher, via the existing pushed_reports
// table) for the current term yet.
async function getMarksPushSummary(school_id, class_level, section, stream, term) {
    const [subjects] = await pool.query(
        'SELECT subject_id, subject_name FROM subjects WHERE stream = ? AND school_id = ? ORDER BY subject_name',
        [stream, school_id]
    );

    const [pushedRows] = await pool.query(
        `SELECT subject_id FROM pushed_reports
         WHERE class_level = ? AND section = ? AND stream = ? AND term = ? AND school_id = ?`,
        [class_level, section, stream, term, school_id]
    );
    const pushedSubjectIds = new Set(pushedRows.map(r => r.subject_id));

    const subjectStatus = subjects.map(s => ({
        subject_id: s.subject_id,
        subject_name: s.subject_name,
        pushed: pushedSubjectIds.has(s.subject_id)
    }));

    const total_subjects = subjects.length;
    const pushed_subjects = subjectStatus.filter(s => s.pushed).length;
    const not_pushed_subjects = subjectStatus.filter(s => !s.pushed).map(s => s.subject_name);
    const percent_pushed = total_subjects > 0 ? (pushed_subjects / total_subjects) * 100 : 100;

    return {
        class_level, section, stream, term,
        total_subjects, pushed_subjects, not_pushed_subjects,
        percent_pushed: Math.round(percent_pushed * 10) / 10,
        subjects: subjectStatus
    };
}

// Status check: how many of this stream's subjects have been pushed for
// the current term, vs. how many exist in total. Frontend uses this to
// show progress and decide whether the push button is enabled.
app.get('/api/homeroom/marks/push-status', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }
        const { class_level, section, stream } = homeroom;
        const term = await getCurrentTerm(req.user.school_id);

        const summary = await getMarksPushSummary(req.user.school_id, class_level, section, stream, term);

        const [alreadyPushed] = await pool.query(
            'SELECT push_id, pushed_at FROM pushed_marks_reports WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ?',
            [req.user.school_id, class_level, section, stream, term]
        );

        res.json({
            ...summary,
            already_pushed: alreadyPushed.length > 0,
            pushed_at: alreadyPushed.length > 0 ? alreadyPushed[0].pushed_at : null
        });
    } catch (err) {
        console.error("marks push-status error:", err);
        res.status(500).json({ error: "Could not load marks push status" });
    }
});

// have been pushed for the current term — per instruction, this is 100%,
// not a partial threshold like the textbook push.
app.post('/api/homeroom/marks/push-report', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }
        const { class_level, section, stream } = homeroom;
        const term = await getCurrentTerm(req.user.school_id);

        const [existingPush] = await pool.query(
            'SELECT push_id FROM pushed_marks_reports WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ?',
            [req.user.school_id, class_level, section, stream, term]
        );
        if (existingPush.length > 0) {
            return res.status(409).json({ error: `This section's ${term} marks report has already been pushed to Academic VP.` });
        }

        const summary = await getMarksPushSummary(req.user.school_id, class_level, section, stream, term);

        if (summary.total_subjects === 0) {
            return res.status(400).json({
                error: "There are no subjects configured for this stream yet, so there's nothing to push.",
                ...summary
            });
        }

        if (summary.pushed_subjects < summary.total_subjects) {
            return res.status(400).json({
                error: `Not all subjects have been pushed yet (${summary.pushed_subjects} of ${summary.total_subjects}). Still waiting on: ${summary.not_pushed_subjects.join(', ')}.`,
                ...summary
            });
        }

        const [insertResult] = await pool.query(
            `INSERT INTO pushed_marks_reports
                (school_id, class_level, section, stream, term, pushed_by, total_subjects, pushed_subjects)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.school_id, class_level, section, stream, term, req.user.user_id,
             summary.total_subjects, summary.pushed_subjects]
        );

        res.json({
            message: `Pushed ${term} marks report to Academic VP: all ${summary.total_subjects} subject(s) included.`,
            push_id: insertResult.insertId,
            ...summary
        });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: `This section's marks report has already been pushed to Academic VP.` });
        }
        console.error("marks push-report error:", err);
        res.status(500).json({ error: "Could not push marks report: " + err.message });
    }
});

// Admin/Principal view: full log + per-subject summary counts, across
// every section/teacher. No admin auth exists yet — same trust level as
// the rest of this API for now; gate this when the admin page is built.
app.get('/api/admin/textbooks', requireAuth, requireRole('admin_users'), async (req, res) => {
    try {
        const school_year = getSchoolYear();

        const [log] = await pool.query(
            `SELECT td.student_id, st.first_name, st.middle_name, st.last_name,
                    st.class_level, st.section, st.stream,
                    s.subject_id, s.subject_name,
                    td.issued_by, td.issued_at, td.status, td.returned_at, td.lost_at
             FROM textbook_distributions td
             JOIN students st ON st.student_id = td.student_id AND st.school_id = td.school_id
             JOIN subjects s ON s.subject_id = td.subject_id AND s.school_id = td.school_id
             WHERE td.school_year = ? AND td.school_id = ?
             ORDER BY st.class_level, st.section, s.subject_name, st.first_name`,
            [school_year, req.user.school_id]
        );

        const [summaryRows] = await pool.query(
            `SELECT s.subject_name,
                    COUNT(*) as total_issued,
                    SUM(CASE WHEN td.status = 'returned' THEN 1 ELSE 0 END) as returned_count,
                    SUM(CASE WHEN td.status = 'lost' THEN 1 ELSE 0 END) as lost_count,
                    SUM(CASE WHEN td.status = 'issued' THEN 1 ELSE 0 END) as not_returned
             FROM textbook_distributions td
             JOIN subjects s ON s.subject_id = td.subject_id AND s.school_id = td.school_id
             WHERE td.school_year = ? AND td.school_id = ?
             GROUP BY s.subject_name
             ORDER BY s.subject_name`,
            [school_year, req.user.school_id]
        );

        res.json({
            school_year,
            summary: summaryRows.map(r => ({
                subject_name: r.subject_name,
                total_issued: r.total_issued,
                returned_count: r.returned_count,
                lost_count: r.lost_count,
                not_returned: r.not_returned
            })),
            log: log.map(r => ({
                student_id: r.student_id,
                full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '),
                class_level: r.class_level,
                section: r.section,
                stream: r.stream,
                subject_name: r.subject_name,
                issued_by: r.issued_by,
                issued_at: r.issued_at,
                status: r.status,
                returned_at: r.returned_at,
                lost_at: r.lost_at
            }))
        });
    } catch (err) {
        console.error("admin textbooks error:", err);
        res.status(500).json({ error: "Could not load textbook records" });
    }
});

// --- Contact School Management ---
// Recipients are role labels ('Principal', 'Admin VP', 'Academic VP'), not
// specific admin_id values, since admin accounts/roles don't exist yet.
// Whoever holds that role (via admin_users.role, once seeded) will see
// threads addressed to them when the admin inbox is built.
const MANAGEMENT_ROLES = ['Principal', 'Admin VP', 'Academic VP'];
const CONTACT_CATEGORIES = ['Permission Request', 'Complaint', 'General Inquiry'];

// Teacher starts a new thread.
app.post('/api/contact/new', requireAuth, async (req, res) => {
    const { recipient_role, category, subject, body } = req.body;

    if (!recipient_role || !category || !subject || !body) {
        return res.status(400).json({ error: "recipient_role, category, subject, and body are all required" });
    }
    if (!MANAGEMENT_ROLES.includes(recipient_role)) {
        return res.status(400).json({ error: `recipient_role must be one of: ${MANAGEMENT_ROLES.join(', ')}` });
    }
    if (!CONTACT_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${CONTACT_CATEGORIES.join(', ')}` });
    }

    try {
        const [threadResult] = await pool.query(
            `INSERT INTO contact_threads (teacher_id, recipient_role, category, subject, school_id)
             VALUES (?, ?, ?, ?, ?)`,
            [req.user.user_id, recipient_role, category, subject, req.user.school_id]
        );
        const thread_id = threadResult.insertId;

        await pool.query(
            `INSERT INTO contact_messages (thread_id, sender_role, sender_id, body, school_id)
             VALUES (?, 'teacher', ?, ?, ?)`,
            [thread_id, req.user.user_id, body, req.user.school_id]
        );

        res.json({ message: "Sent.", thread_id });
    } catch (err) {
        console.error("contact/new error:", err);
        res.status(500).json({ error: "Could not send message" });
    }
});

// Teacher's own inbox: list of their threads with latest activity.
app.get('/api/contact/my-threads', requireAuth, async (req, res) => {
    try {
        const [threads] = await pool.query(
            `SELECT t.thread_id, t.recipient_role, t.category, t.subject, t.status, t.updated_at,
                    (SELECT COUNT(*) FROM contact_messages WHERE thread_id = t.thread_id) as message_count
             FROM contact_threads t
             WHERE t.teacher_id = ? AND t.school_id = ?
             ORDER BY t.updated_at DESC`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(threads);
    } catch (err) {
        console.error("contact/my-threads error:", err);
        res.status(500).json({ error: "Could not load your messages" });
    }
});

// owns this thread before returning anything.
app.get('/api/contact/thread/:thread_id', requireAuth, async (req, res) => {
    const { thread_id } = req.params;

    try {
        const [threadRows] = await pool.query(
            'SELECT * FROM contact_threads WHERE thread_id = ? AND school_id = ?',
            [thread_id, req.user.school_id]
        );
        if (threadRows.length === 0) return res.status(404).json({ error: "Thread not found" });
        if (threadRows[0].teacher_id !== req.user.user_id) {
            return res.status(403).json({ error: "This isn't your thread." });
        }

        const [messages] = await pool.query(
            'SELECT sender_role, sender_id, body, sent_at FROM contact_messages WHERE thread_id = ? AND school_id = ? ORDER BY sent_at ASC',
            [thread_id, req.user.school_id]
        );

        res.json({ thread: threadRows[0], messages });
    } catch (err) {
        console.error("contact/thread error:", err);
        res.status(500).json({ error: "Could not load thread" });
    }
});

// Teacher adds a reply to an existing thread they own.
app.post('/api/contact/thread/:thread_id/reply', requireAuth, async (req, res) => {
    const { body } = req.body;
    const { thread_id } = req.params;

    if (!body) {
        return res.status(400).json({ error: "body is required" });
    }

    try {
        const [threadRows] = await pool.query(
            'SELECT teacher_id FROM contact_threads WHERE thread_id = ? AND school_id = ?',
            [thread_id, req.user.school_id]
        );
        if (threadRows.length === 0) return res.status(404).json({ error: "Thread not found" });
        if (threadRows[0].teacher_id !== req.user.user_id) {
            return res.status(403).json({ error: "This isn't your thread." });
        }

        await pool.query(
            `INSERT INTO contact_messages (thread_id, sender_role, sender_id, body, school_id) VALUES (?, 'teacher', ?, ?, ?)`,
            [thread_id, req.user.user_id, body, req.user.school_id]
        );
        await pool.query('UPDATE contact_threads SET updated_at = NOW() WHERE thread_id = ? AND school_id = ?', [thread_id, req.user.school_id]);

        res.json({ message: "Reply sent." });
    } catch (err) {
        console.error("contact/reply error:", err);
        res.status(500).json({ error: "Could not send reply" });
    }
});

// Teacher (or, once built, the admin inbox) can toggle Open/Resolved.
app.post('/api/contact/thread/:thread_id/status', requireAuth, async (req, res) => {
    const { status } = req.body;
    const { thread_id } = req.params;

    if (!['Open', 'Resolved'].includes(status)) {
        return res.status(400).json({ error: "status must be 'Open' or 'Resolved'" });
    }

    try {
        const [threadRows] = await pool.query(
            'SELECT teacher_id FROM contact_threads WHERE thread_id = ? AND school_id = ?',
            [thread_id, req.user.school_id]
        );
        if (threadRows.length === 0) return res.status(404).json({ error: "Thread not found" });
        if (threadRows[0].teacher_id !== req.user.user_id) {
            return res.status(403).json({ error: "This isn't your thread." });
        }

        await pool.query('UPDATE contact_threads SET status = ?, updated_at = NOW() WHERE thread_id = ? AND school_id = ?', [status, thread_id, req.user.school_id]);
        res.json({ message: `Marked as ${status}.` });
    } catch (err) {
        console.error("contact/status error:", err);
        res.status(500).json({ error: "Could not update status" });
    }
});


// --- School-wide Term Management ---
// GET is open to any logged-in page (teacher dashboard, admin, etc.) so
// everyone can show "Currently: Semester 1" somewhere in the UI.
app.get('/api/term/current', requireAuth, async (req, res) => {
    try {
        const term = await getCurrentTerm(req.user.school_id);
        res.json({ current_term: term, available_terms: TERMS });
    } catch (err) {
        console.error("term/current error:", err);
        res.status(500).json({ error: "Could not load current term" });
    }
});

// POST is intended for the admin page only — there's no admin auth wired
// up yet, so when you build that page, gate this call behind whatever
// admin-only check you add then. For now it's reachable by anyone who
// knows the URL, same trust level as the rest of this API.
app.post('/api/term/set', requireAuth, requireRole('admin_users'), async (req, res) => {
    const { term } = req.body;
    if (!TERMS.includes(term)) {
        return res.status(400).json({ error: `term must be one of: ${TERMS.join(', ')}` });
    }
    try {
        await pool.query(
            `INSERT INTO school_settings (setting_key, setting_value, school_id) VALUES ('current_term', ?, ?)
             ON DUPLICATE KEY UPDATE setting_value = ?`,
            [term, req.user.school_id, term]
        );
        res.json({ message: `Active term set to ${term}`, current_term: term });
    } catch (err) {
        console.error("term/set error:", err);
        res.status(500).json({ error: "Could not update current term" });
    }
});

// Assessment & Exam Conduct status for the dashboard widget.
// For every (subject, section) this teacher is assigned to, and for each
// of the 6 fixed assessment types, this checks whether marks exist for
// at least 50% of ALL students in that section — auto-derived from data,
// not manually toggled.
app.get('/api/teacher/conduct-status', requireAuth, async (req, res) => {
    try {
        // 1. Get every (subject, section) this teacher is assigned to
        const [assignments] = await pool.query(
            `SELECT ta.class_level, ta.section, ta.stream, ta.subject_id, s.subject_name
             FROM teacher_assignments ta
             JOIN subjects s ON s.subject_id = ta.subject_id AND s.school_id = ta.school_id
             WHERE ta.teacher_id = ? AND ta.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );

        const results = [];

        for (const a of assignments) {
            // Total students actually in this section, scoped to this school
            const [[{ total }]] = await pool.query(
                `SELECT COUNT(*) as total FROM students
                 WHERE class_level = ? AND section = ? AND stream = ? AND school_id = ?`,
                [a.class_level, a.section, a.stream, req.user.school_id]
            );

            // Count of distinct students with a mark, per type PER TERM,
            // for this subject+section — so Semester 1 and Semester 2
            // conduct status can be shown side by side, regardless of
            // which term is currently active school-wide.
            const [markCounts] = await pool.query(
                `SELECT m.type, m.term, COUNT(DISTINCT m.student_id) as marked
                 FROM marks m
                 JOIN students st ON st.student_id = m.student_id AND st.school_id = m.school_id
                 WHERE m.subject_id = ? AND m.school_id = ?
                   AND st.class_level = ? AND st.section = ? AND st.stream = ?
                 GROUP BY m.type, m.term`,
                [a.subject_id, req.user.school_id, a.class_level, a.section, a.stream]
            );

            // markedByTerm['Semester 1']['quiz'] = 14
            const markedByTerm = {};
            TERMS.forEach(term => { markedByTerm[term] = {}; });
            markCounts.forEach(row => {
                if (!markedByTerm[row.term]) markedByTerm[row.term] = {};
                markedByTerm[row.term][row.type] = row.marked;
            });

            const checklistByTerm = {};
            TERMS.forEach(term => {
                checklistByTerm[term] = ASSESSMENT_TYPES.map(type => {
                    const marked = (markedByTerm[term] && markedByTerm[term][type]) || 0;
                    const percent = total > 0 ? (marked / total) * 100 : 0;
                    return {
                        type,
                        marked,
                        total,
                        percent: Math.round(percent),
                        conducted: percent >= 50
                    };
                });
            });

            results.push({
                class_level: a.class_level,
                section: a.section,
                stream: a.stream,
                subject_id: a.subject_id,
                subject_name: a.subject_name,
                total_students: total,
                checklistByTerm
            });
        }

        res.json(results);
    } catch (err) {
        console.error("conduct-status error:", err);
        res.status(500).json({ error: "Could not compute conduct status" });
    }
});

// Send a notification to students in a section who haven't submitted a
app.post('/api/teacher/notify-students', requireAuth, async (req, res) => {
    const { class_level, section, stream, assessment_type, message } = req.body;

    if (!class_level || !section || !stream || !assessment_type || !message?.trim()) {
        return res.status(400).json({ error: "class_level, section, stream, assessment_type, and message are required." });
    }

    try {
        // Verify teacher is actually assigned to this section
        const [assigned] = await pool.query(
            `SELECT 1 FROM teacher_assignments
             WHERE teacher_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?`,
            [req.user.user_id, class_level, section, stream, req.user.school_id]
        );
        if (!assigned.length) {
            return res.status(403).json({ error: "You are not assigned to this section." });
        }

        // Find students in this section who have no mark for this assessment type
        const [students] = await pool.query(
            `SELECT DISTINCT s.student_id, s.first_name, s.last_name
             FROM students s
             LEFT JOIN marks m ON m.student_id = s.student_id
               AND m.type = ? AND m.school_id = s.school_id
             WHERE s.class_level = ? AND s.section = ? AND s.stream = ?
               AND s.school_id = ? AND m.mark_id IS NULL
             ORDER BY s.first_name, s.last_name`,
            [assessment_type, class_level, section, stream, req.user.school_id]
        );

        if (!students.length) {
            return res.json({ message: "All students in this section have already completed this assessment.", notified: 0 });
        }

        // Insert one notification row per student
        const rows = students.map(st => [
            st.student_id, req.user.school_id, req.user.user_id,
            assessment_type, message.trim(), section, class_level, stream
        ]);
        await pool.query(
            `INSERT INTO student_notifications
                (student_id, school_id, sent_by, assessment_type, message, section, class_level, stream)
             VALUES ?`,
            [rows]
        );

        res.json({
            message: `Notification sent to ${students.length} student(s) who haven't completed ${assessment_type}.`,
            notified: students.length,
            students: students.map(s => `${s.first_name} ${s.last_name}`)
        });
    } catch (err) {
        console.error("notify-students error:", err);
        res.status(500).json({ error: "Could not send notifications." });
    }
});

app.get('/api/teacher/my-sections', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT DISTINCT class_level, section, stream
             FROM teacher_assignments
             WHERE teacher_id = ? AND school_id = ?
             ORDER BY class_level, section`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Could not fetch sections." });
    }
});

// Returns unread notification count and items: contact thread replies
// the teacher hasn't seen yet (new messages since last_read_at).
app.get('/api/notifications', requireAuth, async (req, res) => {
    try {
        const [threads] = await pool.query(
            `SELECT t.thread_id, t.subject, t.recipient_role, t.last_read_at,
                    COUNT(m.message_id) as reply_count
             FROM contact_threads t
             JOIN contact_messages m ON m.thread_id = t.thread_id
             WHERE t.teacher_id = ? AND t.school_id = ?
               AND m.sender_role != 'teacher'
               AND (t.last_read_at IS NULL OR m.sent_at > t.last_read_at)
             GROUP BY t.thread_id, t.subject, t.recipient_role, t.last_read_at
             ORDER BY MAX(m.sent_at) DESC`,
            [req.user.user_id, req.user.school_id]
        );

        res.json({
            unread_count: threads.reduce((sum, t) => sum + Number(t.reply_count), 0),
            items: threads.map(t => ({
                thread_id: t.thread_id,
                subject: t.subject,
                from: t.recipient_role,
                reply_count: t.reply_count
            }))
        });
    } catch (err) {
        console.error("notifications error:", err);
        res.status(500).json({ error: "Could not load notifications" });
    }
});

// Marks a thread as read up to now so the bell count drops.
app.post('/api/contact/thread/:thread_id/mark-read', requireAuth, async (req, res) => {
    try {
        const [check] = await pool.query(
            'SELECT teacher_id FROM contact_threads WHERE thread_id = ? AND school_id = ?',
            [req.params.thread_id, req.user.school_id]
        );
        if (!check.length || check[0].teacher_id !== req.user.user_id) {
            return res.status(403).json({ error: "Not your thread." });
        }
        await pool.query(
            'UPDATE contact_threads SET last_read_at = NOW() WHERE thread_id = ? AND school_id = ?',
            [req.params.thread_id, req.user.school_id]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: "Could not mark thread as read" });
    }
});

// --- Student Portal Routes ---
// All scoped to the logged-in student's own data via req.user.user_id.
// Students cannot query other students' data.

app.get('/api/student/me', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name, sex,
                    class_level, section, stream, school_name, email_address,
                    lms_username, assigned_computer, status, fayda_number
             FROM students WHERE student_id = ? AND school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );
        if (!rows.length) return res.status(404).json({ error: "Student not found" });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/student/my-marks', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [marks] = await pool.query(
            `SELECT s.subject_name, s.stream, m.type, m.score, m.term
             FROM marks m
             JOIN subjects s ON s.subject_id = m.subject_id AND s.school_id = m.school_id
             WHERE m.student_id = ? AND m.school_id = ?
             ORDER BY m.term, s.subject_name, m.type`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(marks);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/student/my-textbooks', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const school_year = new Date().getFullYear().toString();
        const [books] = await pool.query(
            `SELECT s.subject_name, td.status, td.issued_at, td.returned_at, td.lost_at
             FROM textbook_distributions td
             JOIN subjects s ON s.subject_id = td.subject_id AND s.school_id = td.school_id
             WHERE td.student_id = ? AND td.school_id = ? AND td.school_year = ?
             ORDER BY s.subject_name`,
            [req.user.user_id, req.user.school_id, school_year]
        );
        res.json(books);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/student/my-notifications', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [notifs] = await pool.query(
            `SELECT sn.notif_id, sn.assessment_type, sn.message,
                    sn.sent_at, sn.read_at, t.full_name as sent_by_name
             FROM student_notifications sn
             LEFT JOIN teachers t ON t.teacher_id = sn.sent_by AND t.school_id = sn.school_id
             WHERE sn.student_id = ? AND sn.school_id = ?
             ORDER BY sn.sent_at DESC`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(notifs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/student/mark-notification-read', requireAuth, requireRole('students'), async (req, res) => {
    const { notif_id } = req.body;
    try {
        await pool.query(
            `UPDATE student_notifications SET read_at = NOW()
             WHERE notif_id = ? AND student_id = ? AND school_id = ?`,
            [notif_id, req.user.user_id, req.user.school_id]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Authentication Endpoint ---
app.post('/api/login', async (req, res) => {
    const { id, password } = req.body;

    // Define the tables and their corresponding ID columns
    const authSources = [
        { table: 'students', idCol: 'student_id' },
        { table: 'teachers', idCol: 'teacher_id' },
        { table: 'admin_users', idCol: 'admin_id' },
        { table: 'registrar_users', idCol: 'registrar_id' }
    ];

    try {
        let user = null;
        let userRole = null;

        // Sequentially check each table
        for (const source of authSources) {
            const [rows] = await pool.query(`SELECT * FROM ${source.table} WHERE ${source.idCol} = ?`, [id]);
            if (rows.length > 0) {
                user = rows[0];
                userRole = source.table; // e.g., 'students'
                break;
            }
        }

        if (!user) return res.status(401).json({ error: "ID not found" });

        if (!user.security_password) {
            console.error(`Login error: ${userRole} record for id ${id} has no security_password set`);
            return res.status(500).json({ error: "Account has no password set. Contact an administrator." });
        }

        // Verify password using bcrypt
        const match = await bcrypt.compare(password, user.security_password);
        if (!match) return res.status(401).json({ error: "Invalid password" });

        // Look up the school this account belongs to, so the frontend can
        // display the correct school name immediately without a second
        // round trip, and so we know what to put in the token.
        let school_name = null;
        if (user.school_id) {
            const [schoolRows] = await pool.query('SELECT school_name FROM schools WHERE id = ?', [user.school_id]);
            if (schoolRows.length > 0) school_name = schoolRows[0].school_name;
        }

        issueAuthToken(res, { user_id: id, role: userRole, school_id: user.school_id || null });

        // The token itself is httpOnly and never exposed to JS — this JSON
        // body is just for the frontend to know who's logged in and update
        // the UI (e.g. the school name in the header), not for auth itself.
        res.json({
            message: "Login successful",
            role: userRole,
            id: id,
            school_id: user.school_id || null,
            school_name
        });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ error: "Database error during login" });
    }
});

// Lets the frontend ask "who am I" on page load. Since the token is
// httpOnly, this is the only way client-side JS can know the current
// user's identity/school — it can't decode the cookie itself.
app.get('/api/me', requireAuth, async (req, res) => {
    try {
        let school_name = null;
        if (req.user.school_id) {
            const [schoolRows] = await pool.query('SELECT school_name FROM schools WHERE id = ?', [req.user.school_id]);
            if (schoolRows.length > 0) school_name = schoolRows[0].school_name;
        }

        let additional_role = null;
        if (req.user.role === 'teachers') {
            const [teacherRows] = await pool.query(
                'SELECT additional_role FROM teachers WHERE teacher_id = ? AND school_id = ?',
                [req.user.user_id, req.user.school_id]
            );
            if (teacherRows.length > 0) additional_role = teacherRows[0].additional_role || null;
        }

        res.json({
            user_id: req.user.user_id,
            role: req.user.role,
            school_id: req.user.school_id,
            school_name,
            additional_role
        });
    } catch (err) {
        console.error("/api/me error:", err);
        res.status(500).json({ error: "Could not load your session" });
    }
});

// of (or in addition to) clearing localStorage, since the cookie is the
// real source of truth now.
app.post('/api/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ message: "Logged out." });
});

app.get('/api/teacher/can-access-student', requireAuth, async (req, res) => {
    const { student_id } = req.query;
    try {
        // 1. Get the student's details, scoped to this teacher's own school
        const [students] = await pool.query(
            'SELECT class_level, section, stream FROM students WHERE student_id = ? AND school_id = ?',
            [student_id, req.user.school_id]
        );
        if (students.length === 0) return res.status(404).json({ allowed: false });

        const student = students[0];

        // 2. Check if the teacher has an assignment matching this student
        const [assignment] = await pool.query(
            'SELECT * FROM teacher_assignments WHERE teacher_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?',
            [req.user.user_id, student.class_level, student.section, student.stream, req.user.school_id]
        );

        res.json({ allowed: assignment.length > 0 });
    } catch (err) {
        console.error("can-access-student error:", err);
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/teacher/my-students', requireAuth, async (req, res) => {
    const { search, class_level, section, stream } = req.query;
    try {
        // This query finds all students who belong to a class/section 
        // that the teacher is specifically assigned to, within their own school.
        let sql = `
            SELECT DISTINCT s.* FROM students s
            INNER JOIN teacher_assignments ta 
            ON s.class_level = ta.class_level 
            AND s.section = ta.section 
            AND s.stream = ta.stream
            AND s.school_id = ta.school_id
            WHERE ta.teacher_id = ? AND ta.school_id = ?
        `;
        const params = [req.user.user_id, req.user.school_id];

        if (search && search.trim() !== '') {
            sql += ` AND (s.first_name LIKE ? OR s.middle_name LIKE ? OR s.last_name LIKE ? OR s.student_id LIKE ?)`;
            const term = `%${search.trim()}%`;
            params.push(term, term, term, term);
        }
        if (class_level) { sql += ' AND s.class_level = ?'; params.push(class_level); }
        if (section) { sql += ' AND s.section = ?'; params.push(section); }
        if (stream) { sql += ' AND s.stream = ?'; params.push(stream); }

        sql += ' ORDER BY s.first_name, s.last_name';

        const [rows] = await pool.query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Could not fetch assigned students" });
    }
});
app.get('/api/teacher/my-subjects', requireAuth, async (req, res) => {
    const { stream } = req.query;
    try {
        const sql = `
            SELECT DISTINCT s.subject_id, s.subject_name 
            FROM subjects s
            INNER JOIN teacher_assignments ta ON s.subject_id = ta.subject_id AND s.school_id = ta.school_id
            WHERE ta.teacher_id = ? AND ta.stream = ? AND ta.school_id = ?
        `;
        const [rows] = await pool.query(sql, [req.user.user_id, stream, req.user.school_id]);
        res.json(rows);
    } catch (err) {
        console.error("Database error in /my-subjects:", err);
        res.status(500).json({ error: "Could not fetch subjects" });
    }
});

app.listen(3001, () => console.log("SIS Server running on http://localhost:3001"));

// --- Safety nets: keep the server alive on unexpected errors ---

// Catches errors passed to next(err) or thrown synchronously in route handlers
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: "File is too large. Maximum size is 2MB." });
        }
        return res.status(400).json({ error: "Upload error: " + err.message });
    }
    console.error("Unhandled route error:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Internal server error" });
});

process.on('unhandledRejection', (reason) => {
    console.error("Unhandled Promise rejection:", reason);
});
process.on('uncaughtException', (err) => {
    console.error("Uncaught exception:", err);
});