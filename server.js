import express from 'express';
import mysql from 'mysql2';
import cors from 'cors'; 
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import crypto from 'crypto';
import sizeOf from 'image-size';
import heicConvert from 'heic-convert';
import puppeteer from 'puppeteer';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, ImageRun, BorderStyle } from 'docx';

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
app.use('/students', express.static(path.join(__dirname, 'modules/students')));
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

// --- QR attendance token signing ---
// The QR code on a student's ID card encodes "<student_id>.<signature>"
// rather than the bare student_id, so nobody can produce a valid QR for a
// student by just typing their ID into a generic QR generator — only this
// server (which holds JWT_SECRET) can produce a signature that verifies.
function signQrPayload(id) {
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(id).digest('hex').slice(0, 16);
    return `${id}.${sig}`;
}
function verifyQrPayload(payload) {
    if (typeof payload !== 'string' || !payload.includes('.')) return null;
    const [id, sig] = payload.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(id).digest('hex').slice(0, 16);
    // Constant-time comparison to avoid timing side-channels on the signature check.
    const sigBuf = Buffer.from(sig || '', 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    return id;
}

// Monday-Friday only — adjust here if your school week differs.
function isSchoolDay(date) {
    const day = date.getDay();
    return day !== 0 && day !== 6;
}
function toDateOnly(d) {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
const JWT_EXPIRES_IN = '30m'; // short-lived on purpose — see refresh notes below

function issueAuthToken(res, { user_id, role, school_id, title, is_class_monitor }) {
    const token = jwt.sign({ user_id, role, school_id, title: title || null, is_class_monitor: !!is_class_monitor }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
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

// Requires not just an admin_users account, but specifically the one
// whose admin_users.title = 'Principal'. This assumes admin_users has a
// `title` column — ADD IT if it doesn't exist yet:
//   ALTER TABLE admin_users ADD COLUMN title VARCHAR(50) NULL;
// then set the actual principal's row: title = 'Principal'. Without that
// column populated, every admin_users login will fail this check (title
// comes back null from the token, matching no one) — safer to fail
// closed than to silently let any admin account act as Principal, which
// is exactly the gap this replaces (see MANAGEMENT_ROLES below and the
// admin_users notes on /api/attendance/checkin and /api/announcements).
function requirePrincipal(req, res, next) {
    if (!req.user || req.user.role !== 'admin_users' || req.user.title !== 'Principal') {
        return res.status(403).json({ error: "This action is restricted to the Principal's account." });
    }
    next();
}

// Restricts a route to students who are also flagged as a Class Monitor
// (students.is_class_monitor = 1 — ADD IT if it doesn't exist yet:
//   ALTER TABLE students ADD COLUMN is_class_monitor BOOLEAN NOT NULL DEFAULT FALSE;
// then set it TRUE on the specific students a homeroom teacher designates,
// typically 2 per section). The flag is baked into the JWT at login (see
// issueAuthToken/is_class_monitor), so this is a pure claim check with no
// DB round trip — same trade-off as requirePrincipal above: if the role
// changes mid-session, it won't take effect until the student's 30-minute
// token expires and they log in again.
function requireClassMonitor(req, res, next) {
    if (!req.user || req.user.role !== 'students' || !req.user.is_class_monitor) {
        return res.status(403).json({ error: "This action is restricted to your class's Class Monitor(s)." });
    }
    next();
}

// Mirrors getHomeroomSectionOrNull, but for a student acting as Class
// Monitor: returns their own class_level/section/stream, since a monitor's
// attendance-related permissions are scoped to their own class only, the
// same way a homeroom teacher's are scoped to the section they're
// homeroom for.
async function getMonitorSectionOrNull(student_id, school_id) {
    const [rows] = await pool.query(
        'SELECT class_level, section, stream FROM students WHERE student_id = ? AND school_id = ? AND is_class_monitor = 1',
        [student_id, school_id]
    );
    if (rows.length === 0) return null;
    return { class_level: rows[0].class_level, section: rows[0].section, stream: rows[0].stream };
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

// Set the moment Academic VP last pushed "Start Semester" (POST
// /api/term/set below) — the authoritative start line for every
// day-counting feature: absence counting, the attendance heatmap
// calendar, and the streak. Returns null if the semester has never been
// started yet for this school, in which case callers fall back to
// whatever approximation they used before this existed.
async function getTermStartDate(school_id) {
    const [rows] = await pool.query(
        "SELECT setting_value FROM school_settings WHERE setting_key = 'term_start_date' AND school_id = ?",
        [school_id]
    );
    return rows.length > 0 ? rows[0].setting_value : null; // 'YYYY-MM-DD' string, matches toDateOnly()
}

// Whether the current semester is 'open' or 'closed' — pushed by Academic
// VP via POST /api/term/set (opens, alongside starting/switching the
// term) and POST /api/term/close (closes, without touching current_term
// or term_start_date so the label stays "Closed <last term>" instead of
// resetting). Defaults to 'open' for any school that hasn't touched this
// yet, so nothing that upgrades mid-year suddenly reads as closed.
async function getSemesterStatus(school_id) {
    const [rows] = await pool.query(
        "SELECT setting_value FROM school_settings WHERE setting_key = 'semester_status' AND school_id = ?",
        [school_id]
    );
    return rows.length > 0 ? rows[0].setting_value : 'open';
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
        // Every new student starts with the same default password; they're
        // expected to change it via /api/student/change-password after
        // their first login. Still bcrypt-hashed before it ever touches
        // the database — the plaintext only exists in this request/response.
        const plain_password = '1234';
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
    'text/csv', 'application/vnd.ms-excel', // some browsers send CSV as this
    'application/pdf' // absence-request attachments (e.g. a scanned doctor's note)
];

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — 2MB was rejecting most real phone photos
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const isImage = file.mimetype.startsWith('image/');
        const isCsv = ext === '.csv' || ALLOWED_UPLOAD_MIME_TYPES.includes(file.mimetype);
        const isPdf = ext === '.pdf' || file.mimetype === 'application/pdf';

        if (isImage || isCsv || isPdf) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported file type. Only images (avatar/attachment), .csv (marks), or .pdf (absence attachment) are allowed.'));
        }
    }
});

// Multer's fileFilter/size-limit errors surface as a generic Express
// error unless each upload route's handler is wrapped to catch them —
// this small wrapper turns them into a clean 400 with a useful message
// instead of a raw 500 / unhandled error / Multer's cryptic defaults.
function handleUploadError(uploadMiddleware) {
    return (req, res, next) => {
        uploadMiddleware(req, res, (err) => {
            if (err) {
                if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(400).json({ error: "File is too large. Please use a file under 10MB." });
                }
                return res.status(400).json({ error: err.message || "Upload failed" });
            }
            next();
        });
    };
}

// HEIC/HEIF files are ISO-BMFF containers: bytes 4-8 spell "ftyp", and
// bytes 8-12 carry a brand like "heic"/"heix"/"mif1"/"heim"/"heis"/
// "hevc"/"hevx". We check the actual bytes rather than the filename
// extension, since some phones/share sheets omit the extension or get
// it wrong — our multer filename sanitizer just carries through
// whatever (if anything) it was given.
function isLikelyHeic(buffer) {
    if (buffer.length < 12) return false;
    if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
    const brand = buffer.toString('ascii', 8, 12);
    return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand);
}

// HEIC is the default photo format on iPhones (unless "Most Compatible"
// is chosen in Camera settings), but neither `image-size` nor browsers
// (`<img>` tags) can reliably read/render it. Rather than reject these
// uploads outright, convert them to JPEG on disk and hand back an
// updated file descriptor pointing at the new file. Returns null (and
// leaves the original file untouched) if the file isn't HEIC, or if
// conversion fails for some other reason — callers fall back to their
// normal "unsupported/corrupted file" handling in that case.
async function convertHeicIfNeeded(file) {
    let buffer;
    try {
        buffer = fs.readFileSync(file.path);
    } catch {
        return null;
    }
    if (!isLikelyHeic(buffer)) return null;

    try {
        const outputBuffer = await heicConvert({ buffer, format: 'JPEG', quality: 0.92 });
        const newFilename = file.filename.replace(/\.[^./]*$/, '') + '.jpg';
        const newPath = path.join(path.dirname(file.path), newFilename);
        fs.writeFileSync(newPath, outputBuffer);
        fs.unlink(file.path, () => {}); // remove the original HEIC now that we have the JPEG
        return { ...file, filename: newFilename, path: newPath, mimetype: 'image/jpeg' };
    } catch (err) {
        console.error('HEIC conversion failed:', err);
        return null;
    }
}

// --- Student self-service routes ---
// These must be registered BEFORE /api/student/:id below — Express
// matches routes in registration order, and :id would otherwise capture
// "me", "my-marks", "my-textbooks", and "my-notifications" as literal ID
// values, which is exactly the bug that caused all four to 404 earlier.
//
// Every route here is scoped by req.user.user_id (read off the verified
// JWT), never by a URL param — this is what actually prevents one student
// from viewing another student's marks/textbooks/notifications by just
// changing an ID in the request. requireRole('students') is defense in
// depth on top of that scoping, not a substitute for it.

app.get('/api/student/me', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT st.student_id, st.first_name, st.middle_name, st.last_name, st.class_level, st.section, st.stream, st.sex,
                    st.status, st.school_name, st.lms_username, st.email_address, st.assigned_computer,
                    st.phone_number, st.created_at, st.profile_photo_url, st.id_photo_url, st.is_class_monitor,
                    sc.zone, sc.woreda, sc.region, sc.moe_school_code, sc.school_prefix
             FROM students st
             LEFT JOIN schools sc ON sc.id = st.school_id
             WHERE st.student_id = ? AND st.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Student record not found" });
        const profile = rows[0];
        profile.qr_payload = signQrPayload(profile.student_id);
        res.json(profile);
    } catch (err) {
        console.error("/api/student/me error:", err);
        res.status(500).json({ error: "Could not load your profile" });
    }
});

// Generates a Word (.docx) version of the ID card on demand — not stored
// anywhere, built fresh from current data every request. Simpler layout
// than the printed/PDF card (structured text + photo, not a pixel-perfect
// graphic), but genuinely editable in Word if a school wants to tweak
// wording for a specific student. Same 1-year validity rule as the
// on-screen card (students move up a grade every year).
const DOCX_NO_BORDER = {
    top:    { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    left:   { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    right:  { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
};
function docxFieldRow(labelBi, value) {
    return new TableRow({
        children: [
            new TableCell({
                width: { size: 40, type: WidthType.PERCENTAGE },
                borders: DOCX_NO_BORDER,
                children: [new Paragraph({ children: [new TextRun({ text: labelBi, bold: true, size: 18, color: "666666" })] })]
            }),
            new TableCell({
                width: { size: 60, type: WidthType.PERCENTAGE },
                borders: DOCX_NO_BORDER,
                children: [new Paragraph({ children: [new TextRun({ text: value || '—', size: 22 })] })]
            })
        ]
    });
}

app.get('/api/student/id-card.docx', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT st.student_id, st.first_name, st.middle_name, st.last_name, st.class_level, st.section, st.stream,
                    st.school_name, st.phone_number, st.created_at, st.id_photo_url,
                    sc.moe_school_code
             FROM students st
             LEFT JOIN schools sc ON sc.id = st.school_id
             WHERE st.student_id = ? AND st.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Student record not found" });
        const s = rows[0];

        const full = [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ');
        const issued = s.created_at ? new Date(s.created_at) : new Date();
        const expires = new Date(issued);
        expires.setFullYear(expires.getFullYear() + 1);
        const fmt = d => d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });

        const fieldRows = [
            docxFieldRow('የተማሪ መታወቂያ | Student ID', s.student_id),
            docxFieldRow('ክፍል | Class', `Grade ${s.class_level} - ${s.section}`),
            docxFieldRow('ትምህርት ዘርፍ | Stream', s.stream),
            docxFieldRow('ስልክ ቁጥር | Contact', s.phone_number),
        ];
        if (s.moe_school_code) fieldRows.push(docxFieldRow('የትምህርት ቤት ኮድ | School Code', s.moe_school_code));

        const children = [
            new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: (s.school_name || 'School').toUpperCase(), bold: true, size: 32, color: "1e3a8a" })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'የተማሪ መታወቂያ ካርድ | Student Identity Card', size: 18, color: "666666" })] }),
            new Paragraph({ text: "" }),
        ];

        // Photo is optional — read straight from the uploads dir the same
        // path /uploads/* is served from. Missing/unreadable file just
        // means no photo in the doc, not a failed download.
        if (s.id_photo_url) {
            try {
                const photoPath = path.join(__dirname, 'uploads', path.basename(s.id_photo_url));
                const photoBuf = fs.readFileSync(photoPath);
                children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: photoBuf, transformation: { width: 100, height: 120 } })] }));
                children.push(new Paragraph({ text: "" }));
            } catch (photoErr) {
                console.error("id-card.docx: could not read photo file", photoErr);
            }
        }

        children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: full, bold: true, size: 28, color: "1e3a8a" })] }));
        children.push(new Paragraph({ text: "" }));
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: fieldRows }));
        children.push(new Paragraph({ text: "" }));
        children.push(new Paragraph({ children: [new TextRun({ text: `የተሰጠበት | Issued: ${fmt(issued)}`, size: 18 })] }));
        children.push(new Paragraph({ children: [new TextRun({ text: `እስከ | Valid until: ${fmt(expires)}`, size: 18, bold: true })] }));
        children.push(new Paragraph({ text: "" }));
        children.push(new Paragraph({ children: [new TextRun({ text: 'ርዕሰ መምህር | Principal: _______________________', size: 18 })] }));

        const doc = new Document({ sections: [{ children }] });
        const buffer = await Packer.toBuffer(doc);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="ID-Card-${s.student_id}.docx"`);
        res.send(buffer);
    } catch (err) {
        console.error("/api/student/id-card.docx error:", err);
        res.status(500).json({ error: "Could not generate ID card document" });
    }
});

app.get('/api/student/my-marks', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [marks] = await pool.query(
            `SELECT s.subject_id, s.subject_name, m.score, m.type, m.term
             FROM marks m
             JOIN subjects s ON m.subject_id = s.subject_id AND s.school_id = m.school_id
             WHERE m.student_id = ? AND m.school_id = ?
             ORDER BY m.term, s.subject_name, m.type`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(marks);
    } catch (err) {
        console.error("/api/student/my-marks error:", err);
        res.status(500).json({ error: "Could not fetch your marks" });
    }
});

// --- Mark appeals (student disputes a recorded score) ---
// Requires a new table — run this migration if it doesn't exist yet:
//   CREATE TABLE mark_appeals (
//     appeal_id INT AUTO_INCREMENT PRIMARY KEY,
//     student_id VARCHAR(50) NOT NULL,
//     school_id INT NOT NULL,
//     subject_id INT NOT NULL,
//     term VARCHAR(20) NOT NULL,
//     type VARCHAR(30) NOT NULL,
//     recorded_score DECIMAL(5,2) NOT NULL,
//     claimed_score DECIMAL(5,2) NOT NULL,
//     reason TEXT NOT NULL,
//     status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
//     resolution_note VARCHAR(255) NULL,
//     reviewed_by VARCHAR(50) NULL,
//     reviewed_at DATETIME NULL,
//     requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     INDEX idx_student (student_id, school_id)
//   );
//
// recorded_score is captured at submission time — a snapshot of what the
// mark was when the student flagged it, kept even if the teacher's own
// mark entry changes in the meantime, so the appeal always shows what the
// student was actually disputing. Routed to whichever teacher is
// assigned (via teacher_assignments) to that subject for the student's
// own class — not a fixed "the homeroom teacher handles everything"
// path, since a mark is the actual subject teacher's call to correct.
app.post('/api/student/mark-appeals', requireAuth, requireRole('students'), async (req, res) => {
    const { subject_id, term, type, claimed_score, reason } = req.body;
    if (!subject_id || !term || !type || claimed_score === undefined || claimed_score === null || !reason?.trim()) {
        return res.status(400).json({ error: "subject_id, term, type, claimed_score, and reason are all required." });
    }
    if (!ASSESSMENT_TYPES.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be one of: ${ASSESSMENT_TYPES.join(', ')}` });
    }
    if (typeof claimed_score !== 'number' || claimed_score < 0 || claimed_score > 100) {
        return res.status(400).json({ error: "claimed_score must be a number between 0 and 100." });
    }

    try {
        const [markRows] = await pool.query(
            `SELECT score FROM marks WHERE student_id = ? AND subject_id = ? AND term = ? AND type = ? AND school_id = ?`,
            [req.user.user_id, subject_id, term, type, req.user.school_id]
        );
        if (markRows.length === 0) {
            return res.status(404).json({ error: "No mark has been recorded for this yet — nothing to appeal." });
        }
        const recorded_score = markRows[0].score;
        if (Number(recorded_score) === Number(claimed_score)) {
            return res.status(400).json({ error: "That's already the recorded score." });
        }

        const [existingRows] = await pool.query(
            `SELECT appeal_id FROM mark_appeals
             WHERE student_id = ? AND school_id = ? AND subject_id = ? AND term = ? AND type = ? AND status = 'pending'`,
            [req.user.user_id, req.user.school_id, subject_id, term, type]
        );
        if (existingRows.length > 0) {
            return res.status(409).json({ error: "You already have a pending appeal for this mark." });
        }

        const [result] = await pool.query(
            `INSERT INTO mark_appeals (student_id, school_id, subject_id, term, type, recorded_score, claimed_score, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.user_id, req.user.school_id, subject_id, term, type, recorded_score, claimed_score, reason.trim()]
        );
        res.json({ message: "Appeal submitted.", appeal_id: result.insertId });
    } catch (err) {
        console.error("/api/student/mark-appeals POST error:", err);
        res.status(500).json({ error: "Could not submit your appeal" });
    }
});

app.get('/api/student/mark-appeals', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT ma.appeal_id, ma.subject_id, ma.term, ma.type, ma.recorded_score, ma.claimed_score, ma.reason,
                    ma.status, ma.resolution_note, ma.requested_at, ma.reviewed_at, s.subject_name
             FROM mark_appeals ma
             JOIN subjects s ON s.subject_id = ma.subject_id AND s.school_id = ma.school_id
             WHERE ma.student_id = ? AND ma.school_id = ?
             ORDER BY ma.requested_at DESC`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/student/mark-appeals GET error:", err);
        res.status(500).json({ error: "Could not load your appeals" });
    }
});

// --- Teacher: review mark appeals for subjects they teach ---
app.get('/api/teacher/mark-appeals', requireAuth, requireRole('teachers'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT ma.appeal_id, ma.student_id, ma.subject_id, ma.term, ma.type, ma.recorded_score, ma.claimed_score,
                    ma.reason, ma.requested_at, s.subject_name, st.first_name, st.last_name,
                    st.class_level, st.section, st.stream
             FROM mark_appeals ma
             JOIN students st ON st.student_id = ma.student_id AND st.school_id = ma.school_id
             JOIN subjects s ON s.subject_id = ma.subject_id AND s.school_id = ma.school_id
             JOIN teacher_assignments ta ON ta.subject_id = ma.subject_id AND ta.school_id = ma.school_id
                    AND ta.class_level = st.class_level AND ta.section = st.section AND ta.stream = st.stream
             WHERE ma.school_id = ? AND ma.status = 'pending' AND ta.teacher_id = ?
             ORDER BY ma.requested_at ASC`,
            [req.user.school_id, req.user.user_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/teacher/mark-appeals error:", err);
        res.status(500).json({ error: "Could not load mark appeals" });
    }
});

app.post('/api/teacher/mark-appeals/:id/approve', requireAuth, requireRole('teachers'), async (req, res) => {
    const { corrected_score } = req.body;
    try {
        const [rows] = await pool.query(
            `SELECT ma.appeal_id, ma.student_id, ma.school_id, ma.subject_id, ma.term, ma.type, ma.claimed_score
             FROM mark_appeals ma
             JOIN students st ON st.student_id = ma.student_id AND st.school_id = ma.school_id
             JOIN teacher_assignments ta ON ta.subject_id = ma.subject_id AND ta.school_id = ma.school_id
                    AND ta.class_level = st.class_level AND ta.section = st.section AND ta.stream = st.stream
             WHERE ma.appeal_id = ? AND ma.school_id = ? AND ma.status = 'pending' AND ta.teacher_id = ?`,
            [req.params.id, req.user.school_id, req.user.user_id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "Appeal not found, already reviewed, or not for a subject you teach." });
        }
        const appeal = rows[0];
        const finalScore = (corrected_score === undefined || corrected_score === null) ? appeal.claimed_score : corrected_score;

        // Corrects the actual mark, not just the appeal record — this is
        // a deliberate correction workflow, so it's allowed to update the
        // mark even if normal entry for this class/subject/term has since
        // been pushed to the homeroom teacher and locked (isPushedAndLocked
        // only guards regular /api/add-mark entry, not this).
        await pool.query(
            `UPDATE marks SET score = ? WHERE student_id = ? AND subject_id = ? AND term = ? AND type = ? AND school_id = ?`,
            [finalScore, appeal.student_id, appeal.subject_id, appeal.term, appeal.type, appeal.school_id]
        );
        await pool.query(
            `UPDATE mark_appeals SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE appeal_id = ?`,
            [req.user.user_id, appeal.appeal_id]
        );
        await notifyStudent(
            appeal.student_id, appeal.school_id, req.user.user_id, 'mark_appeal_approved',
            `Your appeal was approved — your ${appeal.type.replace(/_/g, ' ')} score for ${appeal.term} has been corrected to ${finalScore}.`
        );
        res.json({ message: "Appeal approved and mark corrected.", corrected_score: finalScore });
    } catch (err) {
        console.error("/api/teacher/mark-appeals/:id/approve error:", err);
        res.status(500).json({ error: "Could not approve this appeal" });
    }
});

app.post('/api/teacher/mark-appeals/:id/reject', requireAuth, requireRole('teachers'), async (req, res) => {
    const { resolution_note } = req.body;
    try {
        const [rows] = await pool.query(
            `SELECT ma.appeal_id, ma.student_id, ma.school_id, ma.term, ma.type
             FROM mark_appeals ma
             JOIN students st ON st.student_id = ma.student_id AND st.school_id = ma.school_id
             JOIN teacher_assignments ta ON ta.subject_id = ma.subject_id AND ta.school_id = ma.school_id
                    AND ta.class_level = st.class_level AND ta.section = st.section AND ta.stream = st.stream
             WHERE ma.appeal_id = ? AND ma.school_id = ? AND ma.status = 'pending' AND ta.teacher_id = ?`,
            [req.params.id, req.user.school_id, req.user.user_id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "Appeal not found, already reviewed, or not for a subject you teach." });
        }
        const appeal = rows[0];

        await pool.query(
            `UPDATE mark_appeals SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), resolution_note = ? WHERE appeal_id = ?`,
            [req.user.user_id, resolution_note || null, appeal.appeal_id]
        );
        await notifyStudent(
            appeal.student_id, appeal.school_id, req.user.user_id, 'mark_appeal_rejected',
            `Your appeal for your ${appeal.type.replace(/_/g, ' ')} score in ${appeal.term} was reviewed and the recorded score stands.${resolution_note ? ' Note: ' + resolution_note : ''}`
        );
        res.json({ message: "Appeal rejected." });
    } catch (err) {
        console.error("/api/teacher/mark-appeals/:id/reject error:", err);
        res.status(500).json({ error: "Could not reject this appeal" });
    }
});

app.get('/api/student/my-textbooks', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [studentRows] = await pool.query(
            'SELECT stream FROM students WHERE student_id = ? AND school_id = ?',
            [req.user.user_id, req.user.school_id]
        );
        if (studentRows.length === 0) return res.status(404).json({ error: "Student record not found" });
        const { stream } = studentRows[0];
        const school_year = getSchoolYear();

        const [subjects] = await pool.query(
            'SELECT subject_id, subject_name FROM subjects WHERE stream = ? AND school_id = ? ORDER BY subject_name',
            [stream, req.user.school_id]
        );
        const [distributions] = await pool.query(
            `SELECT subject_id, status, issued_at, returned_at, lost_at FROM textbook_distributions
             WHERE student_id = ? AND school_year = ? AND school_id = ?`,
            [req.user.user_id, school_year, req.user.school_id]
        );

        const distroMap = {};
        distributions.forEach(d => { distroMap[d.subject_id] = d; });

        const books = subjects.map(subj => {
            const record = distroMap[subj.subject_id];
            return {
                subject_id: subj.subject_id,
                subject_name: subj.subject_name,
                issued: !!record,
                status: record ? record.status : null,
                issued_at: record ? record.issued_at : null,
                returned: !!(record && record.status === 'returned'),
                returned_at: record ? record.returned_at : null,
                lost: !!(record && record.status === 'lost'),
                lost_at: record ? record.lost_at : null
            };
        });

        res.json({ school_year, books });
    } catch (err) {
        console.error("/api/student/my-textbooks error:", err);
        res.status(500).json({ error: "Could not fetch your textbook status" });
    }
});

app.get('/api/student/my-notifications', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT notif_id, assessment_type, message, section, class_level, stream, sent_at, is_read, read_at
             FROM student_notifications
             WHERE student_id = ? AND school_id = ?
             ORDER BY sent_at DESC`,
            [req.user.user_id, req.user.school_id]
        );
        res.json({
            unread_count: rows.filter(r => !r.is_read).length,
            items: rows
        });
    } catch (err) {
        console.error("/api/student/my-notifications error:", err);
        res.status(500).json({ error: "Could not load your notifications" });
    }
});

app.post('/api/student/mark-notification-read', requireAuth, requireRole('students'), async (req, res) => {
    const { notif_id } = req.body;
    if (!notif_id) {
        return res.status(400).json({ error: "notif_id is required" });
    }
    try {
        const [result] = await pool.query(
            `UPDATE student_notifications SET is_read = 1, read_at = NOW()
             WHERE notif_id = ? AND student_id = ? AND school_id = ?`,
            [notif_id, req.user.user_id, req.user.school_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Notification not found" });
        }
        res.json({ message: "Marked as read" });
    } catch (err) {
        console.error("/api/student/mark-notification-read error:", err);
        res.status(500).json({ error: "Could not update notification" });
    }
});

// --- Attendance ---

// Scanned by a logged-in Principal/Admin VP/Academic VP/Registrar account,
// or a homeroom teacher (for their own section only) — using a device
// camera or the Honeywell scanner. Deliberately NOT a public URL a student
// could hit from home (defeats proving physical presence), and NOT open
// to non-homeroom teachers, per school policy.
//
// NOTE: admin_users currently has no title/role distinction visible to
// this middleware (JWT only carries user_id/role/school_id) — so today
// this allows ANY admin_users account, not specifically Principal/Admin
// VP/Academic VP. If your admin_users table has a title column to
// distinguish those from other admin accounts, tell me and I'll wire it
// into the JWT and add a proper check here.
app.post('/api/attendance/checkin', requireAuth, requireRole('teachers', 'admin_users', 'registrar_users', 'students'), async (req, res) => {
    const { qr_data } = req.body;
    if (!qr_data) return res.status(400).json({ error: "qr_data is required" });

    const student_id = verifyQrPayload(qr_data);
    if (!student_id) {
        return res.status(400).json({ error: "Invalid or tampered QR code" });
    }

    try {
        // Teachers may only take attendance if they're a homeroom teacher,
        // and only for their own section's students. A student may only
        // take attendance if they're their section's Class Monitor —
        // homeroomSection here doubles as "the one section this caller is
        // scoped to," whichever of the two applies.
        let homeroomSection = null;
        if (req.user.role === 'teachers') {
            homeroomSection = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
            if (!homeroomSection) {
                return res.status(403).json({ error: "Only homeroom teachers can take attendance." });
            }
        } else if (req.user.role === 'students') {
            homeroomSection = await getMonitorSectionOrNull(req.user.user_id, req.user.school_id);
            if (!homeroomSection) {
                return res.status(403).json({ error: "Only your class's Class Monitor(s) can take attendance." });
            }
        }

        const [studentRows] = await pool.query(
            'SELECT student_id, first_name, last_name, class_level, section, stream, school_id FROM students WHERE student_id = ? AND school_id = ?',
            [student_id, req.user.school_id]
        );
        if (studentRows.length === 0) {
            return res.status(404).json({ error: "Student not found at your school" });
        }
        const student = studentRows[0];

        if (homeroomSection && (
            student.class_level !== homeroomSection.class_level ||
            student.section !== homeroomSection.section ||
            student.stream !== homeroomSection.stream
        )) {
            return res.status(403).json({ error: "This student isn't in your homeroom section." });
        }

        const today = toDateOnly(new Date());

        const [existing] = await pool.query(
            'SELECT attendance_id FROM student_attendance WHERE student_id = ? AND attendance_date = ?',
            [student_id, today]
        );
        if (existing.length > 0) {
            return res.json({
                message: `${student.first_name} ${student.last_name} was already checked in today`,
                already_checked_in: true,
                student_name: `${student.first_name} ${student.last_name}`
            });
        }

        await pool.query(
            `INSERT INTO student_attendance (student_id, school_id, attendance_date, status, marked_by)
             VALUES (?, ?, ?, 'present', ?)`,
            [student_id, req.user.school_id, today, req.user.user_id]
        );

        res.json({
            message: `Checked in: ${student.first_name} ${student.last_name}`,
            already_checked_in: false,
            student_name: `${student.first_name} ${student.last_name}`
        });
    } catch (err) {
        console.error("/api/attendance/checkin error:", err);
        res.status(500).json({ error: "Check-in failed" });
    }
});

// Admin manually marks a teacher present/absent — teachers don't have a
// QR-bearing ID card yet, so there's no scan-based flow for them yet.
app.post('/api/admin/mark-teacher-attendance', requireAuth, requireRole('admin_users'), async (req, res) => {
    const { teacher_id, status } = req.body;
    if (!teacher_id || !['present', 'absent'].includes(status)) {
        return res.status(400).json({ error: "teacher_id and a valid status ('present' or 'absent') are required" });
    }
    try {
        const today = toDateOnly(new Date());
        await pool.query(
            `INSERT INTO teacher_attendance (teacher_id, school_id, attendance_date, status, marked_by)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status = VALUES(status), marked_by = VALUES(marked_by), marked_at = NOW()`,
            [teacher_id, req.user.school_id, today, status, req.user.user_id]
        );
        res.json({ message: "Attendance recorded" });
    } catch (err) {
        console.error("/api/admin/mark-teacher-attendance error:", err);
        res.status(500).json({ error: "Could not record attendance" });
    }
});

// Shared streak-walking logic: counts consecutive school days (Mon-Fri)
// backward from today that have a 'present' row, stopping at the first
// weekday gap or explicit 'absent'. Weekends are skipped, not counted.
// minDateStr ('YYYY-MM-DD', optional) stops the walk at the semester's
// declared start (see getTermStartDate) — a day before the semester
// officially began was never going to have a real attendance row to
// check in the first place, so it shouldn't be treated as a broken
// streak either.
function computeStreak(presentDatesSet, maxLookbackDays = 120, minDateStr = null) {
    let streak = 0;
    const cursor = new Date();
    for (let i = 0; i < maxLookbackDays; i++) {
        const key = toDateOnly(cursor);
        if (minDateStr && key < minDateStr) break;
        if (isSchoolDay(cursor)) {
            if (presentDatesSet.has(key)) {
                streak++;
            } else {
                // Don't penalize today before school's over / not yet marked —
                // only break the streak on a school day that isn't today.
                if (key !== toDateOnly(new Date())) break;
            }
        }
        cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
}

app.get('/api/student/my-attendance-streak', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT attendance_date FROM student_attendance
             WHERE student_id = ? AND school_id = ? AND status = 'present'
             ORDER BY attendance_date DESC LIMIT 120`,
            [req.user.user_id, req.user.school_id]
        );
        const presentDates = new Set(rows.map(r => toDateOnly(new Date(r.attendance_date))));
        const termStartDate = await getTermStartDate(req.user.school_id);
        res.json({ streak: computeStreak(presentDates, 120, termStartDate), present_today: presentDates.has(toDateOnly(new Date())) });
    } catch (err) {
        console.error("/api/student/my-attendance-streak error:", err);
        res.status(500).json({ error: "Could not load attendance streak" });
    }
});

// Day-by-day attendance for the heatmap calendar widget. Returns one
// ~182-day (26-week) window at a time — weeks_back=0 is the most recent
// window ending today, weeks_back=1 is the window immediately before
// that, and so on, so the widget's "<" button can page backward through
// a student's whole history without ever loading more than one window's
// worth of rows at once. Ethiopian-calendar labels for the tooltip are
// computed client-side (see toEthiopianDate in script.js) — no need to
// send them from here since it's pure date math with no DB dependency.
app.get('/api/student/attendance-calendar', requireAuth, requireRole('students'), async (req, res) => {
    const WINDOW_DAYS = 182;
    const weeksBack = Math.max(0, parseInt(req.query.weeks_back, 10) || 0);

    const to = new Date();
    to.setDate(to.getDate() - weeksBack * WINDOW_DAYS);
    const from = new Date(to);
    from.setDate(from.getDate() - (WINDOW_DAYS - 1));

    try {
        const [presentRows] = await pool.query(
            `SELECT attendance_date FROM student_attendance
             WHERE student_id = ? AND school_id = ? AND status = 'present'
               AND attendance_date >= ? AND attendance_date <= ?`,
            [req.user.user_id, req.user.school_id, toDateOnly(from), toDateOnly(to)]
        );
        const presentSet = new Set(presentRows.map(r => toDateOnly(new Date(r.attendance_date))));

        // Same excused-day logic as countAbsentDays() — an approved
        // absence request colors that day differently from an
        // unexplained absence, rather than just lumping them together.
        const [excusedRows] = await pool.query(
            `SELECT date_from, date_to FROM absence_requests
             WHERE student_id = ? AND school_id = ? AND status = 'approved'
               AND date_to >= ? AND date_from <= ?`,
            [req.user.user_id, req.user.school_id, toDateOnly(from), toDateOnly(to)]
        );
        const excusedSet = new Set();
        excusedRows.forEach(r => {
            const cur = new Date(r.date_from);
            const end = new Date(r.date_to);
            while (cur <= end) {
                excusedSet.add(toDateOnly(cur));
                cur.setDate(cur.getDate() + 1);
            }
        });

        const today = toDateOnly(new Date());
        const termStartDate = await getTermStartDate(req.user.school_id);
        const days = [];
        const cursor = new Date(from);
        while (cursor <= to) {
            const dateStr = toDateOnly(cursor);
            let status;
            if (termStartDate && dateStr < termStartDate) status = 'not_started';
            else if (!isSchoolDay(cursor)) status = 'weekend';
            else if (dateStr > today) status = 'future';
            else if (presentSet.has(dateStr)) status = 'present';
            else if (excusedSet.has(dateStr)) status = 'excused';
            else status = 'absent';
            days.push({ date: dateStr, status });
            cursor.setDate(cursor.getDate() + 1);
        }

        res.json({ from: toDateOnly(from), to: toDateOnly(to), term_start_date: termStartDate, days });
    } catch (err) {
        console.error("/api/student/attendance-calendar error:", err);
        res.status(500).json({ error: "Could not load attendance calendar" });
    }
});

// --- Class Timetable ---
// Requires a new table — run this migration if it doesn't exist yet:
//   CREATE TABLE class_timetable (
//     timetable_id INT AUTO_INCREMENT PRIMARY KEY,
//     school_id INT NOT NULL,
//     class_level VARCHAR(20) NOT NULL,
//     section VARCHAR(20) NOT NULL,
//     stream VARCHAR(20) NOT NULL,
//     day_of_week TINYINT NOT NULL,  -- 1=Monday ... 5=Friday, matches JS Date#getDay()
//     subject_id INT NOT NULL,
//     teacher_id VARCHAR(50) NULL,
//     start_time TIME NOT NULL,
//     end_time TIME NOT NULL,
//     INDEX idx_class (school_id, class_level, section, stream, day_of_week)
//   );
// Returns the student's whole-week schedule (not just today) — the
// Dashboard widget filters down to "today" client-side, so the same
// response can also back a full weekly view later without a second call.
app.get('/api/student/my-timetable', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [studentRows] = await pool.query(
            'SELECT class_level, section, stream FROM students WHERE student_id = ? AND school_id = ?',
            [req.user.user_id, req.user.school_id]
        );
        if (studentRows.length === 0) return res.status(404).json({ error: "Student record not found" });
        const { class_level, section, stream } = studentRows[0];

        const [rows] = await pool.query(
            `SELECT ct.timetable_id, ct.day_of_week, ct.start_time, ct.end_time,
                    s.subject_name, t.first_name AS teacher_first_name, t.last_name AS teacher_last_name
             FROM class_timetable ct
             JOIN subjects s ON s.subject_id = ct.subject_id AND s.school_id = ct.school_id
             LEFT JOIN teachers t ON t.teacher_id = ct.teacher_id AND t.school_id = ct.school_id
             WHERE ct.school_id = ? AND ct.class_level = ? AND ct.section = ? AND ct.stream = ?
             ORDER BY ct.day_of_week, ct.start_time`,
            [req.user.school_id, class_level, section, stream]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/student/my-timetable error:", err);
        res.status(500).json({ error: "Could not load your timetable" });
    }
});

// --- Teacher leave (Academic VP / Admin grants a teacher excused leave) ---
// Requires a new table — run this migration if it doesn't exist yet:
//   CREATE TABLE teacher_leave (
//     leave_id INT AUTO_INCREMENT PRIMARY KEY,
//     teacher_id VARCHAR(50) NOT NULL,
//     school_id INT NOT NULL,
//     date_from DATE NOT NULL,
//     date_to DATE NOT NULL,
//     reason VARCHAR(255) NULL,
//     granted_by VARCHAR(50) NOT NULL,
//     granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     INDEX idx_teacher (teacher_id, school_id)
//   );
//
// Unlike the student absence_requests flow, this isn't a request/approval
// workflow — a teacher doesn't submit anything here. Admin grants leave
// directly (e.g. after a conversation, a doctor's note handed in person,
// etc.), and that grant is what makes a period/day excused. There's
// intentionally no way for anyone but admin_users to create, see the
// full list of, or revoke these rows.
async function isTeacherOnLeave(teacher_id, school_id, date) {
    const [rows] = await pool.query(
        `SELECT 1 FROM teacher_leave WHERE teacher_id = ? AND school_id = ? AND date_from <= ? AND date_to >= ? LIMIT 1`,
        [teacher_id, school_id, date, date]
    );
    return rows.length > 0;
}

app.post('/api/admin/teacher-leave', requireAuth, requireRole('admin_users'), async (req, res) => {
    const { teacher_id, date_from, date_to, reason } = req.body;
    if (!teacher_id || !date_from || !date_to) {
        return res.status(400).json({ error: "teacher_id, date_from, and date_to are required." });
    }
    if (new Date(date_to) < new Date(date_from)) {
        return res.status(400).json({ error: "date_to can't be before date_from." });
    }
    try {
        const [result] = await pool.query(
            `INSERT INTO teacher_leave (teacher_id, school_id, date_from, date_to, reason, granted_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [teacher_id, req.user.school_id, date_from, date_to, reason || null, req.user.user_id]
        );
        res.json({ message: "Leave granted. This teacher's absence won't count against them for these dates.", leave_id: result.insertId });
    } catch (err) {
        console.error("/api/admin/teacher-leave POST error:", err);
        res.status(500).json({ error: "Could not grant leave" });
    }
});

app.get('/api/admin/teacher-leave', requireAuth, requireRole('admin_users'), async (req, res) => {
    const { teacher_id } = req.query;
    try {
        const [rows] = await pool.query(
            `SELECT leave_id, teacher_id, date_from, date_to, reason, granted_by, granted_at
             FROM teacher_leave WHERE school_id = ? ${teacher_id ? 'AND teacher_id = ?' : ''}
             ORDER BY date_from DESC`,
            teacher_id ? [req.user.school_id, teacher_id] : [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/admin/teacher-leave GET error:", err);
        res.status(500).json({ error: "Could not load teacher leave records" });
    }
});

app.delete('/api/admin/teacher-leave/:id', requireAuth, requireRole('admin_users'), async (req, res) => {
    try {
        const [result] = await pool.query(
            'DELETE FROM teacher_leave WHERE leave_id = ? AND school_id = ?',
            [req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Leave record not found" });
        res.json({ message: "Leave record revoked." });
    } catch (err) {
        console.error("/api/admin/teacher-leave DELETE error:", err);
        res.status(500).json({ error: "Could not revoke leave record" });
    }
});

// --- Period attendance log (Class Monitor marks whether the teacher for
// each period actually showed up) ---
// Requires a new table — run this migration if it doesn't exist yet:
//   CREATE TABLE period_attendance_log (
//     log_id INT AUTO_INCREMENT PRIMARY KEY,
//     timetable_id INT NOT NULL,
//     school_id INT NOT NULL,
//     log_date DATE NOT NULL,
//     teacher_present BOOLEAN NOT NULL,
//     marked_by VARCHAR(50) NOT NULL,   -- the Class Monitor's student_id
//     marked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     UNIQUE KEY one_log_per_period_per_day (timetable_id, log_date)
//   );
//
// This is intentionally a monitor-only, mark-only log — a teacher can see
// their own subject timetable (GET /api/teacher/my-timetable below) but
// has no endpoint anywhere that lets them touch class_timetable OR
// period_attendance_log. That asymmetry is the whole point: it's a
// punctuality signal that feeds into teacher performance, so a teacher
// being able to edit their own record would defeat it. Only a Class
// Monitor (marking, same-day only) and Admin (read/report, see below)
// can act on it. A period whose teacher has an approved teacher_leave
// grant for that date is never markable at all — see teacher_on_leave in
// the response below and the same check in the POST endpoint — so an
// excused absence simply never becomes a log row in the first place,
// rather than being logged as an absence and then explained away.
app.get('/api/student/todays-periods', requireAuth, requireClassMonitor, async (req, res) => {
    try {
        const monitorSection = await getMonitorSectionOrNull(req.user.user_id, req.user.school_id);
        if (!monitorSection) return res.status(403).json({ error: "Only your class's Class Monitor(s) can view this." });

        const today = toDateOnly(new Date());
        const todayDow = new Date().getDay();

        const [rows] = await pool.query(
            `SELECT ct.timetable_id, ct.start_time, ct.end_time, ct.teacher_id, s.subject_name,
                    t.first_name AS teacher_first_name, t.last_name AS teacher_last_name,
                    pal.teacher_present, pal.marked_at,
                    tl.reason AS leave_reason
             FROM class_timetable ct
             JOIN subjects s ON s.subject_id = ct.subject_id AND s.school_id = ct.school_id
             LEFT JOIN teachers t ON t.teacher_id = ct.teacher_id AND t.school_id = ct.school_id
             LEFT JOIN period_attendance_log pal ON pal.timetable_id = ct.timetable_id AND pal.log_date = ?
             LEFT JOIN teacher_leave tl ON tl.teacher_id = ct.teacher_id AND tl.school_id = ct.school_id
                    AND tl.date_from <= ? AND tl.date_to >= ?
             WHERE ct.school_id = ? AND ct.class_level = ? AND ct.section = ? AND ct.stream = ? AND ct.day_of_week = ?
             ORDER BY ct.start_time`,
            [today, today, today, req.user.school_id, monitorSection.class_level, monitorSection.section, monitorSection.stream, todayDow]
        );
        // teacher_on_leave is derived from the LEFT JOIN, not a raw column —
        // simpler for the frontend than having to know what a non-null
        // leave_reason implies.
        res.json(rows.map(r => ({ ...r, teacher_on_leave: r.leave_reason !== null })));
    } catch (err) {
        console.error("/api/student/todays-periods error:", err);
        res.status(500).json({ error: "Could not load today's periods" });
    }
});

app.post('/api/student/mark-period-attendance', requireAuth, requireClassMonitor, async (req, res) => {
    const { timetable_id, teacher_present } = req.body;
    if (!timetable_id || typeof teacher_present !== 'boolean') {
        return res.status(400).json({ error: "timetable_id and a boolean teacher_present are required." });
    }
    try {
        const monitorSection = await getMonitorSectionOrNull(req.user.user_id, req.user.school_id);
        if (!monitorSection) return res.status(403).json({ error: "Only your class's Class Monitor(s) can do this." });

        const today = toDateOnly(new Date());
        const todayDow = new Date().getDay();

        // Confirm this period is (a) actually the monitor's own class and
        // (b) actually scheduled for TODAY — a monitor can't mark a period
        // that isn't happening today, which is what stops backdating or
        // pre-filling a week's worth of "present" marks in one sitting.
        const [periodRows] = await pool.query(
            `SELECT timetable_id, teacher_id FROM class_timetable
             WHERE timetable_id = ? AND school_id = ? AND class_level = ? AND section = ? AND stream = ? AND day_of_week = ?`,
            [timetable_id, req.user.school_id, monitorSection.class_level, monitorSection.section, monitorSection.stream, todayDow]
        );
        if (periodRows.length === 0) {
            return res.status(404).json({ error: "That period isn't on your class's timetable for today." });
        }

        // A teacher with an approved leave grant for today can't be marked
        // at all — excused means excused, not "logged absent, but it's
        // fine." See isTeacherOnLeave/teacher_leave above.
        const period = periodRows[0];
        if (period.teacher_id && await isTeacherOnLeave(period.teacher_id, req.user.school_id, today)) {
            return res.status(400).json({ error: "This teacher has approved leave today — nothing to mark." });
        }

        // Upsert, not insert-only — lets the monitor correct a mis-tap
        // later the same day. The UNIQUE(timetable_id, log_date) key means
        // this can never create two rows for the same period/day either
        // way, whether it's the first mark or a same-day correction.
        await pool.query(
            `INSERT INTO period_attendance_log (timetable_id, school_id, log_date, teacher_present, marked_by)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE teacher_present = VALUES(teacher_present), marked_by = VALUES(marked_by), marked_at = NOW()`,
            [timetable_id, req.user.school_id, today, teacher_present, req.user.user_id]
        );
        res.json({ message: "Recorded.", timetable_id, teacher_present });
    } catch (err) {
        console.error("/api/student/mark-period-attendance error:", err);
        res.status(500).json({ error: "Could not record this" });
    }
});

// Read-only — a teacher can see their own weekly schedule, full stop.
// No corresponding PUT/PATCH/DELETE exists for a teacher on
// class_timetable or period_attendance_log anywhere in this file, on
// purpose (see the note above period_attendance_log's schema).
app.get('/api/teacher/my-timetable', requireAuth, requireRole('teachers'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT ct.timetable_id, ct.day_of_week, ct.start_time, ct.end_time,
                    ct.class_level, ct.section, ct.stream, s.subject_name
             FROM class_timetable ct
             JOIN subjects s ON s.subject_id = ct.subject_id AND s.school_id = ct.school_id
             WHERE ct.school_id = ? AND ct.teacher_id = ?
             ORDER BY ct.day_of_week, ct.start_time`,
            [req.user.school_id, req.user.user_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/teacher/my-timetable error:", err);
        res.status(500).json({ error: "Could not load your timetable" });
    }
});

// Admin-side punctuality report — aggregates period_attendance_log for a
// given teacher (optionally within a date range; defaults to the last 30
// days). This is the "counts toward teacher performance" number the log
// exists to produce. Loosely gated to any admin_users account for now,
// same note as elsewhere in this file about tightening to a specific
// title once one exists.
app.get('/api/admin/teacher-punctuality', requireAuth, requireRole('admin_users'), async (req, res) => {
    const { teacher_id } = req.query;
    if (!teacher_id) return res.status(400).json({ error: "teacher_id is required" });

    const to = req.query.to ? toDateOnly(new Date(req.query.to)) : toDateOnly(new Date());
    const from = req.query.from ? toDateOnly(new Date(req.query.from)) : toDateOnly(new Date(Date.now() - 30 * 86400000));

    try {
        const [rows] = await pool.query(
            `SELECT pal.log_date, pal.teacher_present, s.subject_name, ct.start_time, ct.end_time,
                    ct.class_level, ct.section, ct.stream
             FROM period_attendance_log pal
             JOIN class_timetable ct ON ct.timetable_id = pal.timetable_id
             JOIN subjects s ON s.subject_id = ct.subject_id AND s.school_id = ct.school_id
             WHERE pal.school_id = ? AND ct.teacher_id = ? AND pal.log_date >= ? AND pal.log_date <= ?
             ORDER BY pal.log_date DESC, ct.start_time`,
            [req.user.school_id, teacher_id, from, to]
        );
        const present_count = rows.filter(r => r.teacher_present).length;

        // Leave days never generate period_attendance_log rows at all (see
        // the note on mark-period-attendance above), so they're already
        // excluded from present_count/absent_count — this is purely
        // informational, so an admin reading the report can tell "no
        // periods logged" apart from "was on leave the whole time."
        const [leaveRows] = await pool.query(
            `SELECT date_from, date_to FROM teacher_leave
             WHERE teacher_id = ? AND school_id = ? AND date_to >= ? AND date_from <= ?`,
            [teacher_id, req.user.school_id, from, to]
        );

        res.json({
            teacher_id, from, to,
            total_logged_periods: rows.length,
            present_count,
            absent_count: rows.length - present_count,
            punctuality_rate: rows.length ? Math.round((present_count / rows.length) * 100) : null,
            leave_grants_in_range: leaveRows,
            periods: rows
        });
    } catch (err) {
        console.error("/api/admin/teacher-punctuality error:", err);
        res.status(500).json({ error: "Could not load punctuality report" });
    }
});

// --- Admin: manage the class timetable ---
// Loosely gated to any admin_users account for now, same as the other
// admin endpoints noted elsewhere in this file (see the absence-requests
// admin section above) — there's no dedicated "Academic Coordinator"
// title distinction yet. This is a bare CRUD with no timetable-builder UI
// behind it yet either; it exists so the table can actually be populated
// (e.g. via a quick admin script or Postman) before the teacher/admin
// site has a proper screen for it.
app.get('/api/admin/timetable', requireAuth, requireRole('admin_users'), async (req, res) => {
    const { class_level, section, stream } = req.query;
    if (!class_level || !section || !stream) {
        return res.status(400).json({ error: "class_level, section, and stream are required" });
    }
    try {
        const [rows] = await pool.query(
            `SELECT ct.timetable_id, ct.day_of_week, ct.start_time, ct.end_time, ct.subject_id, ct.teacher_id,
                    s.subject_name
             FROM class_timetable ct
             JOIN subjects s ON s.subject_id = ct.subject_id AND s.school_id = ct.school_id
             WHERE ct.school_id = ? AND ct.class_level = ? AND ct.section = ? AND ct.stream = ?
             ORDER BY ct.day_of_week, ct.start_time`,
            [req.user.school_id, class_level, section, stream]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/admin/timetable GET error:", err);
        res.status(500).json({ error: "Could not load timetable" });
    }
});

app.post('/api/admin/timetable', requireAuth, requireRole('admin_users'), async (req, res) => {
    const { class_level, section, stream, day_of_week, subject_id, teacher_id, start_time, end_time } = req.body;
    if (!class_level || !section || !stream || !day_of_week || !subject_id || !start_time || !end_time) {
        return res.status(400).json({ error: "class_level, section, stream, day_of_week, subject_id, start_time, and end_time are required." });
    }
    if (day_of_week < 1 || day_of_week > 5) {
        return res.status(400).json({ error: "day_of_week must be 1 (Monday) through 5 (Friday)." });
    }
    if (end_time <= start_time) {
        return res.status(400).json({ error: "end_time must be after start_time." });
    }
    try {
        const [result] = await pool.query(
            `INSERT INTO class_timetable (school_id, class_level, section, stream, day_of_week, subject_id, teacher_id, start_time, end_time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.school_id, class_level, section, stream, day_of_week, subject_id, teacher_id || null, start_time, end_time]
        );
        res.json({ message: "Timetable slot added.", timetable_id: result.insertId });
    } catch (err) {
        console.error("/api/admin/timetable POST error:", err);
        res.status(500).json({ error: "Could not add timetable slot" });
    }
});

app.delete('/api/admin/timetable/:id', requireAuth, requireRole('admin_users'), async (req, res) => {
    try {
        const [result] = await pool.query(
            'DELETE FROM class_timetable WHERE timetable_id = ? AND school_id = ?',
            [req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Timetable slot not found" });
        res.json({ message: "Timetable slot removed." });
    } catch (err) {
        console.error("/api/admin/timetable DELETE error:", err);
        res.status(500).json({ error: "Could not remove timetable slot" });
    }
});

app.get('/api/teacher/my-attendance-streak', requireAuth, requireRole('teachers'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT attendance_date FROM teacher_attendance
             WHERE teacher_id = ? AND school_id = ? AND status = 'present'
             ORDER BY attendance_date DESC LIMIT 120`,
            [req.user.user_id, req.user.school_id]
        );
        const presentDates = new Set(rows.map(r => toDateOnly(new Date(r.attendance_date))));
        const termStartDate = await getTermStartDate(req.user.school_id);
        res.json({ streak: computeStreak(presentDates, 120, termStartDate), present_today: presentDates.has(toDateOnly(new Date())) });
    } catch (err) {
        console.error("/api/teacher/my-attendance-streak error:", err);
        res.status(500).json({ error: "Could not load attendance streak" });
    }
});

// Manual fallback for when neither the camera nor the Honeywell scanner is
// available — teacher types the student ID directly. No QR signature to
// verify here (there's no physical card being read), so this relies on
// the same trust model as calling roll from a paper list: an authenticated
// staff member vouching for a specific student's presence.
app.post('/api/attendance/manual-checkin', requireAuth, requireRole('teachers', 'admin_users', 'registrar_users', 'students'), async (req, res) => {
    const { student_id } = req.body;
    if (!student_id) return res.status(400).json({ error: "student_id is required" });

    try {
        let homeroomSection = null;
        if (req.user.role === 'teachers') {
            homeroomSection = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
            if (!homeroomSection) {
                return res.status(403).json({ error: "Only homeroom teachers can take attendance." });
            }
        } else if (req.user.role === 'students') {
            homeroomSection = await getMonitorSectionOrNull(req.user.user_id, req.user.school_id);
            if (!homeroomSection) {
                return res.status(403).json({ error: "Only your class's Class Monitor(s) can take attendance." });
            }
        }

        const [studentRows] = await pool.query(
            'SELECT student_id, first_name, last_name, class_level, section, stream FROM students WHERE student_id = ? AND school_id = ?',
            [student_id, req.user.school_id]
        );
        if (studentRows.length === 0) {
            return res.status(404).json({ error: "No student with that ID at your school" });
        }
        const student = studentRows[0];

        if (homeroomSection && (
            student.class_level !== homeroomSection.class_level ||
            student.section !== homeroomSection.section ||
            student.stream !== homeroomSection.stream
        )) {
            return res.status(403).json({ error: "This student isn't in your homeroom section." });
        }

        const today = toDateOnly(new Date());

        const [existing] = await pool.query(
            'SELECT attendance_id FROM student_attendance WHERE student_id = ? AND attendance_date = ?',
            [student_id, today]
        );
        if (existing.length > 0) {
            return res.json({
                message: `${student.first_name} ${student.last_name} was already checked in today`,
                already_checked_in: true,
                student_name: `${student.first_name} ${student.last_name}`
            });
        }

        await pool.query(
            `INSERT INTO student_attendance (student_id, school_id, attendance_date, status, marked_by)
             VALUES (?, ?, ?, 'present', ?)`,
            [student_id, req.user.school_id, today, req.user.user_id]
        );

        res.json({
            message: `Checked in: ${student.first_name} ${student.last_name}`,
            already_checked_in: false,
            student_name: `${student.first_name} ${student.last_name}`
        });
    } catch (err) {
        console.error("/api/attendance/manual-checkin error:", err);
        res.status(500).json({ error: "Check-in failed" });
    }
});

// Lets a Class Monitor see today's (or any given day's) attendance for
// their own class — who's present, who's absent, and for anyone absent,
// whether an absence request already covers that day (so the monitor
// isn't chasing a student who's already sorted it out with the homeroom
// teacher). Read-only — actually taking attendance is the checkin/
// manual-checkin endpoints above, which a monitor can also call.
app.get('/api/student/my-class-attendance', requireAuth, requireClassMonitor, async (req, res) => {
    const date = req.query.date ? toDateOnly(new Date(req.query.date)) : toDateOnly(new Date());
    try {
        const monitorSection = await getMonitorSectionOrNull(req.user.user_id, req.user.school_id);
        if (!monitorSection) return res.status(403).json({ error: "Only your class's Class Monitor(s) can view this." });

        const [students] = await pool.query(
            `SELECT student_id, first_name, last_name FROM students
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ?
             ORDER BY first_name, last_name`,
            [req.user.school_id, monitorSection.class_level, monitorSection.section, monitorSection.stream]
        );

        const [presentRows] = await pool.query(
            `SELECT student_id FROM student_attendance
             WHERE school_id = ? AND attendance_date = ? AND status = 'present'`,
            [req.user.school_id, date]
        );
        const presentSet = new Set(presentRows.map(r => r.student_id));

        const [excusedRows] = await pool.query(
            `SELECT student_id, status FROM absence_requests
             WHERE school_id = ? AND date_from <= ? AND date_to >= ? AND status IN ('pending', 'approved', 'escalated')`,
            [req.user.school_id, date, date]
        );
        const excusedMap = new Map(excusedRows.map(r => [r.student_id, r.status]));

        const roster = students.map(s => ({
            student_id: s.student_id,
            name: `${s.first_name} ${s.last_name}`,
            present: presentSet.has(s.student_id),
            absence_request_status: excusedMap.get(s.student_id) || null
        }));

        res.json({ date, roster, absent_count: roster.filter(r => !r.present).length });
    } catch (err) {
        console.error("/api/student/my-class-attendance error:", err);
        res.status(500).json({ error: "Could not load class attendance" });
    }
});

// --- Certificate PDF generation ---
const CERTIFICATE_TEMPLATE_PATH = path.join(__dirname, 'templates', 'certificate.html');

// Approximate Ethiopian calendar year for display (e.g. "2017 E.C."),
// derived from a Gregorian date. Ethiopian New Year falls around Sept
// 11 (Sept 12 the year before an Ethiopian leap year) — this uses Sept
// 11 as a fixed cutoff, which is correct the large majority of years
// but can be a day off right at the boundary. Good enough for a label
// on a printed document; not used for any real date math elsewhere.
function approximateEthiopianYear(gregorianDate) {
    const d = new Date(gregorianDate);
    const newYearCutoff = new Date(d.getFullYear(), 8, 11); // Sept 11
    return d >= newYearCutoff ? d.getFullYear() - 7 : d.getFullYear() - 8;
}

// Certificate photo intentionally reuses the same id_photo_url as the ID
// card (per your call) — embedded as a base64 data URI so Puppeteer
// doesn't need network/file access mid-render, same reasoning as why
// id-card.docx embeds the photo bytes directly rather than a URL.
function buildPhotoHtml(photoUrl) {
    if (!photoUrl) return '<div class="photo">Student<br>Photo</div>';
    try {
        const photoPath = path.join(__dirname, 'uploads', path.basename(photoUrl));
        const buf = fs.readFileSync(photoPath);
        const ext = path.extname(photoPath).slice(1).toLowerCase();
        const mime = { png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg';
        return `<img class="photo" style="object-fit:cover;" src="data:${mime};base64,${buf.toString('base64')}" alt="Student photo">`;
    } catch (err) {
        console.error('certificate photo read failed:', err);
        return '<div class="photo">Student<br>Photo</div>';
    }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fills the server-side certificate template (templates/certificate.html,
// never served directly — see the route below) with one student's real
// data via plain token replacement. The template's own <script> still
// does all the per-subject math (totals, averages, ratings) exactly as
// designed; this only injects the raw numbers and bio/school text.
function renderCertificateHtml(data) {
    let html = fs.readFileSync(CERTIFICATE_TEMPLATE_PATH, 'utf8');

    const tokens = {
        __REGION_AMH__: data.region_amh || '',
        __REGION__: escapeHtml(data.region || '—'),
        __SCHOOL_NAME_AMH__: data.school_name_amh || '',
        __SCHOOL_NAME__: escapeHtml(data.school_name || 'School'),
        __PHOTO_HTML__: data.photo_html,
        __STUDENT_ID__: escapeHtml(data.student_id),
        __STUDENT_NAME__: escapeHtml(data.student_name),
        __SEX__: escapeHtml(data.sex || '—'),
        __GRADE__: escapeHtml(data.grade),
        __SECTION__: escapeHtml(data.section),
        __STREAM__: escapeHtml(data.stream || '—'),
        __ACADEMIC_YEAR__: escapeHtml(data.academic_year || '—'),
        __ZONE__: escapeHtml(data.zone || '—'),
        __WOREDA__: escapeHtml(data.woreda || '—'),
        __TOWN__: escapeHtml(data.town || '—'),
        __HOMEROOM_TEACHER_NAME__: escapeHtml(data.homeroom_teacher_name || '—')
    };
    for (const [token, value] of Object.entries(tokens)) {
        html = html.split(token).join(value);
    }

    // Subjects/rank/absences travel as one JSON blob rather than flat
    // tokens — JSON.stringify handles its own escaping; the extra
    // </script>-breaking guard covers a subject name containing "</script>".
    const dataJson = JSON.stringify({
        subjects: data.subjects,
        conduct: data.conduct,
        absent_days_s1: data.absent_days_s1,
        absent_days_s2: data.absent_days_s2,
        rank: data.rank,
        class_size: data.class_size,
        verify_url: data.verify_url
    }).replace(/</g, '\\u003c');
    html = html.replace('__CERT_DATA_JSON__', dataJson);

    return html;
}

// A single shared headless Chromium instance, launched lazily on first
// use and reused across requests — launching a fresh browser per
// request would make every certificate download several seconds slower
// for no benefit. --no-sandbox is commonly required when running as
// root in a container; drop it if your host runs Chromium as a
// non-root user with proper OS sandboxing available.
let _browserPromise = null;
function getBrowser() {
    if (!_browserPromise) {
        _browserPromise = puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    }
    return _browserPromise;
}

// --- Certificate ---
// Rounds to 2 decimals without floating-point artifacts (e.g. 85 instead
// of 84.99999999999999).
function round2(n) {
    return Math.round(n * 100) / 100;
}

// Each subject's Semester 1/2 total is already a 0-100 percentage (the 6
// assessment types are pre-weighted to sum to 100), so a plain mean of
// the two is a valid year-end percentage — e.g. 90 and 80 becomes 85.
// Returns null if either semester is missing; a "year average" isn't
// meaningful with only half the year's data.
function yearAverage(s1, s2) {
    if (s1 == null || s2 == null) return null;
    return round2((Number(s1) + Number(s2)) / 2);
}

// Mean of a list of subject-level percentages (a term's subject totals,
// or a set of subjects' year averages) — used for a student's OVERALL
// average across all their subjects, as opposed to one subject's score.
// Ignores nulls (e.g. a subject missing its year average because only
// one semester exists) rather than treating them as zero.
function overallAverage(values) {
    const present = values.filter(v => v != null).map(Number);
    if (present.length === 0) return null;
    return round2(present.reduce((a, b) => a + b, 0) / present.length);
}

// Standard "competition ranking": ties share the same rank, and the next
// distinct score skips ahead accordingly (1, 2, 2, 4 — not 1, 2, 2, 3).
// Entries with a null score are excluded entirely — not ranked, not
// counted toward class_size — rather than being placed last, since a
// null here means that student's data isn't complete/comparable.
// Returns a Map from student_id -> { rank, class_size }.
function rankStudents(entries) {
    const ranked = entries.filter(e => e.score != null).sort((a, b) => b.score - a.score);
    const class_size = ranked.length;
    const result = new Map();
    let rank = 0;
    let seen = 0;
    let lastScore = null;
    ranked.forEach(e => {
        seen++;
        if (e.score !== lastScore) {
            rank = seen;
            lastScore = e.score;
        }
        result.set(String(e.student_id), { rank, class_size });
    });
    return result;
}

// Every student's overall average for one term, within one class_level +
// section + stream — the same pool of students a subject teacher pushed
// scores for. This is the comparison group rank is computed against, so
// it deliberately mirrors /api/homeroom/section-report's query rather
// than e.g. "everyone currently enrolled" (which could include students
// who joined after the push, or exclude ones who've since left).
async function getSectionTermAverages(school_id, class_level, section, stream, term) {
    const [scoreRows] = await pool.query(
        `SELECT prs.student_id, prs.total_score
         FROM pushed_report_scores prs
         JOIN pushed_reports pr ON pr.push_id = prs.push_id AND pr.school_id = prs.school_id
         WHERE pr.school_id = ? AND pr.class_level = ? AND pr.section = ? AND pr.stream = ? AND pr.term = ?`,
        [school_id, class_level, section, stream, term]
    );
    const byStudent = {};
    scoreRows.forEach(r => {
        if (!byStudent[r.student_id]) byStudent[r.student_id] = [];
        byStudent[r.student_id].push(Number(r.total_score));
    });
    return Object.keys(byStudent).map(student_id => ({
        student_id,
        score: overallAverage(byStudent[student_id])
    }));
}

// Every student's year average within one class_level + section + stream
// — pairs each student's two semester averages the same way a single
// student's year_average is computed (yearAverage/overallAverage above),
// so an individual's rank and the class's rank list can never disagree
// on how the underlying number was calculated.
async function getSectionYearAverages(school_id, class_level, section, stream) {
    const [s1rows, s2rows] = await Promise.all([
        getSectionTermAverages(school_id, class_level, section, stream, 'Semester 1'),
        getSectionTermAverages(school_id, class_level, section, stream, 'Semester 2')
    ]);
    const s1map = new Map(s1rows.map(r => [String(r.student_id), r.score]));
    const s2map = new Map(s2rows.map(r => [String(r.student_id), r.score]));
    const studentIds = new Set([...s1map.keys(), ...s2map.keys()]);
    return [...studentIds].map(student_id => ({
        student_id,
        score: yearAverage(s1map.get(student_id), s2map.get(student_id))
    }));
}

// Every student's year average across the ENTIRE school, compared as one
// pool regardless of grade — the comparison group for the school-wide
// "top student" recognition award, as opposed to rankStudents()/
// getSectionYearAverages() above, which only ever compare within one
// section. Note this deliberately compares Grade 9 against Grade 12 on
// the same scale, which your call was to do explicitly — worth knowing
// since different grades take different subjects/difficulty. A separate,
// lighter-weight query rather than looping getCertificateTerms() per
// student, which would do several unnecessary extra queries per student
// (rank, absences) that this feature doesn't need.
//
// For a student who has multiple completed (both-semesters-synced) class
// levels on file (i.e. they were promoted after a prior full year), only
// their MOST RECENT class level counts — that's their current standing,
// not a past one.
async function getSchoolYearLeaderboard(school_id) {
    const [scoreRows] = await pool.query(
        `SELECT prs.student_id, pr.class_level, pr.section, pr.stream, pr.term, prs.total_score
         FROM pushed_report_scores prs
         JOIN pushed_reports pr ON pr.push_id = prs.push_id AND pr.school_id = prs.school_id
         WHERE pr.school_id = ?`,
        [school_id]
    );
    const [syncRows] = await pool.query(
        `SELECT class_level, section, stream, term FROM pushed_marks_reports WHERE school_id = ?`,
        [school_id]
    );
    const syncedSet = new Set(syncRows.map(r => `${r.class_level}|${r.section}|${r.stream}|${r.term}`));

    // student_id -> class_level -> { section, stream, s1: [scores], s2: [scores] }
    const byStudent = {};
    scoreRows.forEach(r => {
        if (!byStudent[r.student_id]) byStudent[r.student_id] = {};
        if (!byStudent[r.student_id][r.class_level]) {
            byStudent[r.student_id][r.class_level] = { section: r.section, stream: r.stream, s1: [], s2: [] };
        }
        const bucket = byStudent[r.student_id][r.class_level];
        if (r.term === 'Semester 1') bucket.s1.push(Number(r.total_score));
        else if (r.term === 'Semester 2') bucket.s2.push(Number(r.total_score));
    });

    const leaderboard = [];
    for (const student_id of Object.keys(byStudent)) {
        let best = null;
        for (const [class_level, entry] of Object.entries(byStudent[student_id])) {
            const { section, stream, s1, s2 } = entry;
            const s1Synced = syncedSet.has(`${class_level}|${section}|${stream}|Semester 1`);
            const s2Synced = syncedSet.has(`${class_level}|${section}|${stream}|Semester 2`);
            if (!s1Synced || !s2Synced) continue; // year rank only — same rule as everywhere else

            const yearAvg = yearAverage(overallAverage(s1), overallAverage(s2));
            if (yearAvg == null) continue;
            if (!best || Number(class_level) > Number(best.class_level)) {
                best = { class_level, section, stream, year_average: yearAvg };
            }
        }
        if (best) leaderboard.push({ student_id, ...best });
    }

    leaderboard.sort((a, b) => b.year_average - a.year_average);
    return leaderboard;
}

// Days absent within a term, inferred from attendance check-ins — the
// same signal the Dashboard's attendance streak already uses (a
// student_attendance row only ever gets written as 'present'; absence is
// never recorded directly, just implied by a missing school-day row).
// The term's start boundary is whatever Academic VP last set via POST
// /api/term/set (see getTermStartDate) — if that's never been pushed for
// this school, this falls back to the older approximation (day after the
// previous term synced, or the student's account creation date) so
// nothing breaks for a school that hasn't adopted the Start Semester
// button yet.
async function countAbsentDays(student_id, school_id, class_level, section, stream, term, syncedAt) {
    let startDate = null;

    if (term === 'Semester 2') {
        const [prevSync] = await pool.query(
            `SELECT pushed_at FROM pushed_marks_reports
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = 'Semester 1'`,
            [school_id, class_level, section, stream]
        );
        if (prevSync.length > 0) {
            startDate = new Date(prevSync[0].pushed_at);
            startDate.setDate(startDate.getDate() + 1); // day AFTER Semester 1 synced
        }
    }
    if (!startDate) {
        const [studentRows] = await pool.query(
            'SELECT created_at FROM students WHERE student_id = ? AND school_id = ?',
            [student_id, school_id]
        );
        startDate = studentRows.length > 0 ? new Date(studentRows[0].created_at) : new Date(syncedAt);
    }

    // Never count a day before the semester was actually declared
    // started, even if the fallback above would otherwise reach further
    // back (e.g. a student's account was created weeks before classes
    // began).
    const termStartDate = await getTermStartDate(school_id);
    if (termStartDate && new Date(termStartDate) > startDate) {
        startDate = new Date(termStartDate);
    }

    const endDate = new Date(syncedAt);
    if (startDate > endDate) return 0;

    const [presentRows] = await pool.query(
        `SELECT attendance_date FROM student_attendance
         WHERE student_id = ? AND school_id = ? AND status = 'present'
           AND attendance_date >= ? AND attendance_date <= ?`,
        [student_id, school_id, toDateOnly(startDate), toDateOnly(endDate)]
    );
    const presentSet = new Set(presentRows.map(r => toDateOnly(new Date(r.attendance_date))));

    // Approved absence requests (homeroom-reviewed leave/permission, e.g.
    // illness or a hospital visit) excuse those specific days — they
    // still show as "not present" in student_attendance, but shouldn't
    // count against the student the way an unexplained absence does.
    const [excusedRows] = await pool.query(
        `SELECT date_from, date_to FROM absence_requests
         WHERE student_id = ? AND school_id = ? AND status = 'approved'
           AND date_to >= ? AND date_from <= ?`,
        [student_id, school_id, toDateOnly(startDate), toDateOnly(endDate)]
    );
    const excusedSet = new Set();
    excusedRows.forEach(r => {
        const cur = new Date(r.date_from);
        const end = new Date(r.date_to);
        while (cur <= end) {
            excusedSet.add(toDateOnly(cur));
            cur.setDate(cur.getDate() + 1);
        }
    });

    let absentDays = 0;
    const cursor = new Date(startDate);
    while (cursor <= endDate) {
        const day = toDateOnly(cursor);
        if (isSchoolDay(cursor) && !presentSet.has(day) && !excusedSet.has(day)) absentDays++;
        cursor.setDate(cursor.getDate() + 1);
    }
    return absentDays;
}

// Built on student_enrollment_history (what class/section/stream/term the
// student was actually in each year) plus the existing push pipeline:
// a term counts as "synced" only if pushed_marks_reports has a row for
// that exact class_level/section/stream/term — meaning homeroom already
// confirmed every subject was pushed and forwarded to Academic VP. The
// certificate as a whole is only "ready" once every term in the student's
// history is synced this way.
// Shared: builds each term's sync status (plus score breakdown) from
// enrollment history + the push pipeline. Used by both /my-certificate
// (which needs the score breakdown to display) and /request-certificate
// (which only needs the ready/synced verdict) — keeping the query logic
// in one place means the two can't drift out of sync on what "ready"
// means, which is exactly what caused an earlier bug here.
async function getCertificateTerms(student_id, school_id) {
    const [historyRows] = await pool.query(
        `SELECT class_level, section, stream, term FROM student_enrollment_history
         WHERE student_id = ? AND school_id = ?
         ORDER BY class_level, term`,
        [student_id, school_id]
    );

    return Promise.all(historyRows.map(async (h) => {
        const [syncRows] = await pool.query(
            `SELECT pushed_at FROM pushed_marks_reports
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ?`,
            [school_id, h.class_level, h.section, h.stream, h.term]
        );
        const synced = syncRows.length > 0;

        const [scoreRows] = await pool.query(
            `SELECT s.subject_name, prs.total_score
             FROM pushed_report_scores prs
             JOIN pushed_reports pr ON pr.push_id = prs.push_id AND pr.school_id = prs.school_id
             JOIN subjects s ON s.subject_id = pr.subject_id AND s.school_id = pr.school_id
             WHERE prs.student_id = ? AND pr.school_id = ? AND pr.class_level = ?
               AND pr.section = ? AND pr.stream = ? AND pr.term = ?`,
            [student_id, school_id, h.class_level, h.section, h.stream, h.term]
        );

        // Rank only gets computed once this term is actually synced — an
        // unsynced term could still have partial/incomplete pushes for
        // other students in the section, which would make any comparison
        // meaningless (and misleading if printed on a certificate).
        let rank = null, class_size = null;
        if (synced) {
            const sectionAverages = await getSectionTermAverages(school_id, h.class_level, h.section, h.stream, h.term);
            const ranks = rankStudents(sectionAverages);
            const mine = ranks.get(String(student_id));
            if (mine) { rank = mine.rank; class_size = mine.class_size; }
        }

        const days_absent = synced
            ? await countAbsentDays(student_id, school_id, h.class_level, h.section, h.stream, h.term, syncRows[0].pushed_at)
            : null;

        return {
            class_level: h.class_level,
            section: h.section,
            stream: h.stream,
            term: h.term,
            synced,
            synced_at: synced ? syncRows[0].pushed_at : null,
            subjects: scoreRows,
            term_total: scoreRows.reduce((s, r) => s + Number(r.total_score), 0),
            term_average: overallAverage(scoreRows.map(r => r.total_score)),
            rank,
            class_size,
            days_absent
        };
    }));
}

// Once BOTH semesters of a class level are synced, pair up each subject's
// two semester totals into a year average, plus an overall year average
// across all of that class level's subjects, plus this student's year
// RANK within their section (see getSectionYearAverages). A class level
// with only one semester synced doesn't get an entry at all — per your
// call, year/rank figures wait for the full year, though each semester's
// own average and rank (term_average/rank above) are already visible as
// soon as that semester syncs.
async function buildYearSummaries(student_id, school_id, terms) {
    const classLevels = [...new Set(terms.map(t => t.class_level))];
    const summaries = await Promise.all(classLevels.map(async (class_level) => {
        const s1 = terms.find(t => t.class_level === class_level && t.term === 'Semester 1');
        const s2 = terms.find(t => t.class_level === class_level && t.term === 'Semester 2');
        if (!s1?.synced || !s2?.synced) return null;

        const subjectNames = [...new Set([...s1.subjects, ...s2.subjects].map(s => s.subject_name))].sort();
        const subjects = subjectNames.map(name => {
            const s1v = s1.subjects.find(s => s.subject_name === name)?.total_score ?? null;
            const s2v = s2.subjects.find(s => s.subject_name === name)?.total_score ?? null;
            return {
                subject_name: name,
                semester_1: s1v != null ? Number(s1v) : null,
                semester_2: s2v != null ? Number(s2v) : null,
                year_average: yearAverage(s1v, s2v)
            };
        });

        // s1 and s2 should normally share the same section/stream (a
        // student doesn't usually change section mid-year within one
        // class level) — s2's is used since it's the more recent of the two.
        const sectionAverages = await getSectionYearAverages(school_id, class_level, s2.section, s2.stream);
        const ranks = rankStudents(sectionAverages);
        const mine = ranks.get(String(student_id));

        return {
            class_level,
            subjects,
            year_average: overallAverage(subjects.map(s => s.year_average)),
            rank: mine ? mine.rank : null,
            class_size: mine ? mine.class_size : null,
            days_absent: (s1.days_absent ?? 0) + (s2.days_absent ?? 0)
        };
    }));
    return summaries.filter(Boolean);
}

// A class level only counts as done once EVERY term in TERMS (both
// Semester 1 and Semester 2) is represented in history and synced —
// not just whichever terms happen to have been pushed so far. Without
// this, a class level with only Semester 1 pushed would pass a plain
// ".every(synced)" check on its one existing row, making the
// certificate "ready" right after Semester 1 closes instead of waiting
// for Semester 2 as intended.
function isCertificateReady(termRows) {
    if (termRows.length === 0) return false;
    const classLevels = [...new Set(termRows.map(t => t.class_level))];
    return classLevels.every(level =>
        TERMS.every(term => termRows.some(t => t.class_level === level && t.term === term && t.synced))
    );
}

app.get('/api/student/my-certificate', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const terms = await getCertificateTerms(req.user.user_id, req.user.school_id);

        if (terms.length === 0) {
            return res.json({ ready: false, terms: [], message: "No pushed marks history yet." });
        }

        const ready = isCertificateReady(terms);
        const year_summary = await buildYearSummaries(req.user.user_id, req.user.school_id, terms);
        res.json({ ready, terms, year_summary });
    } catch (err) {
        console.error("/api/student/my-certificate error:", err);
        res.status(500).json({ error: "Could not load certificate data" });
    }
});

// Official (synced) averages for the student's own Dashboard / My Marks
// pages. Same underlying data as the certificate, but without the
// certificate's full "every term ready" gate — a single synced
// semester's average is meaningful to show on its own, well before the
// whole certificate (or the whole year) is ready.
app.get('/api/student/my-average', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const terms = await getCertificateTerms(req.user.user_id, req.user.school_id);
        const year_summary = await buildYearSummaries(req.user.user_id, req.user.school_id, terms);
        res.json({ terms, year_summary });
    } catch (err) {
        console.error("/api/student/my-average error:", err);
        res.status(500).json({ error: "Could not load your averages" });
    }
});

// The actual downloadable certificate — gated behind BOTH readiness
// (every term synced) AND an approved certificate_requests row (homeroom
// sign-off). Readiness alone means the data exists; approval is the
// actual human decision to release it. Uses the most recently completed
// class level (last entry in year_summary) as the one to print.
app.get('/api/student/certificate.pdf', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const terms = await getCertificateTerms(req.user.user_id, req.user.school_id);
        if (!isCertificateReady(terms)) {
            return res.status(400).json({ error: "Your certificate isn't ready yet — every term needs to be synced by your homeroom teacher first." });
        }

        const [approvedRows] = await pool.query(
            `SELECT request_id FROM certificate_requests WHERE student_id = ? AND school_id = ? AND status = 'approved'`,
            [req.user.user_id, req.user.school_id]
        );
        if (approvedRows.length === 0) {
            return res.status(400).json({ error: "Your certificate request hasn't been approved by your homeroom teacher yet." });
        }

        const year_summary = await buildYearSummaries(req.user.user_id, req.user.school_id, terms);
        if (year_summary.length === 0) {
            return res.status(400).json({ error: "No completed academic year found." });
        }
        const latest = year_summary[year_summary.length - 1];
        const s1 = terms.find(t => t.class_level === latest.class_level && t.term === 'Semester 1');
        const s2 = terms.find(t => t.class_level === latest.class_level && t.term === 'Semester 2');

        const [studentRows] = await pool.query(
            `SELECT st.student_id, st.first_name, st.middle_name, st.last_name, st.sex, st.id_photo_url,
                    sc.school_name, sc.zone, sc.woreda, sc.region
             FROM students st
             LEFT JOIN schools sc ON sc.id = st.school_id
             WHERE st.student_id = ? AND st.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );
        if (studentRows.length === 0) return res.status(404).json({ error: "Student record not found" });
        const s = studentRows[0];

        const [homeroomRows] = await pool.query(
            `SELECT first_name, middle_name, last_name FROM teachers
             WHERE school_id = ? AND homeroom_class_level = ? AND homeroom_section = ? AND homeroom_stream = ?`,
            [req.user.school_id, latest.class_level, s2.section, s2.stream]
        );
        const homeroomTeacherName = homeroomRows.length > 0
            ? [homeroomRows[0].first_name, homeroomRows[0].middle_name, homeroomRows[0].last_name].filter(Boolean).join(' ')
            : '';

        const html = renderCertificateHtml({
            school_name: s.school_name,
            region: s.region,
            zone: s.zone,
            woreda: s.woreda,
            town: s.woreda, // no separate "town" field on file — closest available match
            photo_html: buildPhotoHtml(s.id_photo_url),
            student_id: s.student_id,
            student_name: [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' '),
            sex: s.sex,
            grade: latest.class_level,
            section: s2.section,
            stream: s2.stream,
            academic_year: s2.synced_at ? `${approximateEthiopianYear(s2.synced_at)} E.C.` : null,
            homeroom_teacher_name: homeroomTeacherName,
            subjects: latest.subjects.map(sub => ({ en: sub.subject_name, amh: null, s1: sub.semester_1, s2: sub.semester_2 })),
            conduct: null, // no conduct-tracking feature yet — left blank on purpose, not fabricated
            absent_days_s1: s1 ? s1.days_absent : null,
            absent_days_s2: s2 ? s2.days_absent : null,
            rank: latest.rank,
            class_size: latest.class_size,
            verify_url: `${req.protocol}://${req.get('host')}/verify/${s.student_id}`
        });

        const browser = await getBrowser();
        const page = await browser.newPage();
        try {
            await page.setContent(html, { waitUntil: 'networkidle0' });
            const pdfBuffer = await page.pdf({ printBackground: true, preferCSSPageSize: true });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="Certificate-${s.student_id}.pdf"`);
            res.send(pdfBuffer);
        } finally {
            await page.close();
        }
    } catch (err) {
        console.error("/api/student/certificate.pdf error:", err);
        res.status(500).json({ error: "Could not generate certificate" });
    }
});

// Public verification page for the certificate's QR code — confirms a
// certificate is genuine without exposing any grades. Deliberately
// unauthenticated (that's the point: anyone holding the physical
// certificate can scan and check it), but only ever returns pass/fail
// plus name/school — never marks, rank, or attendance.
app.get('/verify/:student_id', async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT st.student_id, st.first_name, st.middle_name, st.last_name, sc.school_name,
                    (SELECT COUNT(*) FROM certificate_requests
                     WHERE student_id = st.student_id AND school_id = st.school_id AND status = 'approved') AS approved_count
             FROM students st
             LEFT JOIN schools sc ON sc.id = st.school_id
             WHERE st.student_id = ?`,
            [req.params.student_id]
        );
        if (rows.length === 0 || rows[0].approved_count === 0) {
            return res.status(404).send(
                '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:60px;">' +
                '<h2>Not found</h2><p>No approved certificate matches this code.</p></body></html>'
            );
        }
        const s = rows[0];
        const fullName = escapeHtml([s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' '));
        res.send(
            '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:60px;">' +
            '<h2>&#10003; Certificate Verified</h2>' +
            `<p>This certificate was issued by <strong>${escapeHtml(s.school_name || 'the school')}</strong> to <strong>${fullName}</strong> (ID ${escapeHtml(s.student_id)}).</p>` +
            '</body></html>'
        );
    } catch (err) {
        console.error("/verify error:", err);
        res.status(500).send('Could not verify certificate');
    }
});

// --- School-wide Recognition Award ---
// Requires a new table — run this migration if it doesn't exist yet:
//   CREATE TABLE recognition_awards (
//     award_id INT AUTO_INCREMENT PRIMARY KEY,
//     student_id VARCHAR(50) NOT NULL,
//     school_id INT NOT NULL,
//     class_level VARCHAR(20) NOT NULL,
//     year_average DECIMAL(5,2) NOT NULL,
//     awarded_by VARCHAR(50) NOT NULL,   -- admin_id of the Principal
//     awarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     UNIQUE KEY one_award_per_student_per_level (student_id, school_id, class_level)
//   );
// Also requires admin_users.title = 'Principal' on the actual principal's
// account — see requirePrincipal() above.

// Principal reviews who's currently at the top of the whole school
// (across every grade) before deciding whether to award recognition.
// Deliberately shows the top few, not just #1 — a genuine tie for first
// means more than one student may deserve it, and it's the Principal's
// call which (or how many) to actually award.
app.get('/api/principal/school-leaderboard', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const leaderboard = await getSchoolYearLeaderboard(req.user.school_id);
        if (leaderboard.length === 0) {
            return res.json({ class_size: 0, leaders: [], ranked: [] });
        }

        // "Average Rank" — rank is based on each student's overall YEAR
        // AVERAGE across their own subjects, not e.g. a raw total (which
        // would unfairly favor a student who happens to take more
        // subjects than another). Same competition-ranking rules as
        // every other leaderboard in this app: ties share a rank, and
        // the next distinct score skips ahead accordingly.
        const ranks = rankStudents(leaderboard.map(l => ({ student_id: l.student_id, score: l.year_average })));
        const class_size = [...ranks.values()][0]?.class_size ?? 0;

        const [studentRows] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name FROM students
             WHERE school_id = ? AND student_id IN (?)`,
            [req.user.school_id, leaderboard.map(l => l.student_id)]
        );
        const namesById = new Map(studentRows.map(s => [String(s.student_id), [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ')]));

        const [alreadyAwarded] = await pool.query(
            `SELECT student_id FROM recognition_awards WHERE school_id = ? AND student_id IN (?)`,
            [req.user.school_id, leaderboard.map(l => l.student_id)]
        );
        const awardedSet = new Set(alreadyAwarded.map(r => String(r.student_id)));

        const ranked = leaderboard.map(l => ({
            ...l,
            full_name: namesById.get(String(l.student_id)) || null,
            rank: ranks.get(String(l.student_id))?.rank ?? null,
            already_awarded: awardedSet.has(String(l.student_id))
        }));

        // Rank 1 by construction — kept as its own field since a genuine
        // tie means more than one student shares it, and that's who's
        // actually eligible for the award below, not just "whoever sorted first."
        const leaders = ranked.filter(l => l.rank === 1);

        res.json({ class_size, leaders, ranked });
    } catch (err) {
        console.error("school-leaderboard error:", err);
        res.status(500).json({ error: "Could not load the school leaderboard" });
    }
});

// The actual award — one action, by the Principal, that both confirms
// and issues it (there's no separate "request" step here the way there
// is for a student's own certificate, since the school computes the
// leader itself; the Principal's role is to sign off on releasing it).
// Only allowed for a student currently ranked #1 (Average Rank, ties
// included) — not open discretion to award anyone, so a Principal can't
// accidentally (or deliberately) recognize someone who isn't really leading.
app.post('/api/principal/recognition-awards', requireAuth, requirePrincipal, async (req, res) => {
    const { student_id } = req.body;
    if (!student_id) return res.status(400).json({ error: "student_id is required" });

    try {
        const leaderboard = await getSchoolYearLeaderboard(req.user.school_id);
        if (leaderboard.length === 0) {
            return res.status(400).json({ error: "No student has a completed, synced year yet." });
        }
        const ranks = rankStudents(leaderboard.map(l => ({ student_id: l.student_id, score: l.year_average })));
        const mine = ranks.get(String(student_id));
        if (!mine || mine.rank !== 1) {
            return res.status(400).json({ error: "This student isn't currently ranked #1 school-wide (Average Rank)." });
        }
        const entry = leaderboard.find(l => String(l.student_id) === String(student_id));

        await pool.query(
            `INSERT INTO recognition_awards (student_id, school_id, class_level, year_average, awarded_by)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE year_average = VALUES(year_average), awarded_by = VALUES(awarded_by), awarded_at = CURRENT_TIMESTAMP`,
            [entry.student_id, req.user.school_id, entry.class_level, entry.year_average, req.user.user_id]
        );

        res.json({ message: "Recognition award issued.", student_id: entry.student_id, class_level: entry.class_level, year_average: entry.year_average });
    } catch (err) {
        console.error("recognition-award issue error:", err);
        res.status(500).json({ error: "Could not issue the recognition award" });
    }
});

// A student's own view of whether they've received this — analogous to
// /api/student/my-certificate, but for the recognition award instead.
app.get('/api/student/my-recognition-award', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT class_level, year_average, awarded_at FROM recognition_awards
             WHERE student_id = ? AND school_id = ?
             ORDER BY awarded_at DESC LIMIT 1`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(rows.length > 0 ? { awarded: true, ...rows[0] } : { awarded: false });
    } catch (err) {
        console.error("my-recognition-award error:", err);
        res.status(500).json({ error: "Could not load recognition award status" });
    }
});

// --- Student photo uploads ---
// Two different photos, two different rules:
//   - profile photo: whatever the student wants, just needs to be an image
//   - ID photo: just needs to be a real image above a minimum resolution.
//     We used to also require portrait orientation (taller than wide),
//     but that turned out unreliable: many phone photos store landscape
//     pixel dimensions with an EXIF rotation tag that makes them DISPLAY
//     as portrait everywhere else, while image-size reports the raw
//     pre-rotation dimensions — so genuinely portrait photos kept getting
//     rejected. The ID card already crops any photo to fit its photo box
//     with CSS object-fit:cover, so this check was never load-bearing;
//     dropping it instead of chasing EXIF-orientation edge cases.
const ID_PHOTO_MIN_WIDTH = 300;
const ID_PHOTO_MIN_HEIGHT = 360;

app.post('/api/student/upload-profile-photo', requireAuth, requireRole('students'), handleUploadError(upload.single('photo')), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        if (!req.file.mimetype.startsWith('image/')) {
            return res.status(400).json({ error: "Profile photo must be an image file (JPEG, PNG, GIF, or WEBP)." });
        }

        const converted = await convertHeicIfNeeded(req.file);
        if (converted) req.file = converted;

        const filePath = `/uploads/${req.file.filename}`;
        await pool.query(
            'UPDATE students SET profile_photo_url = ? WHERE student_id = ? AND school_id = ?',
            [filePath, req.user.user_id, req.user.school_id]
        );
        res.json({ profile_photo_url: filePath });
    } catch (err) {
        console.error("/api/student/upload-profile-photo error:", err);
        res.status(500).json({ error: "Upload failed" });
    }
});

app.post('/api/student/upload-id-photo', requireAuth, requireRole('students'), handleUploadError(upload.single('photo')), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        if (!req.file.mimetype.startsWith('image/')) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: "ID photo must be an image file (JPEG, PNG, GIF, or WEBP)." });
        }

        const converted = await convertHeicIfNeeded(req.file);
        if (converted) req.file = converted;

        let dimensions;
        try {
            dimensions = sizeOf(req.file.path);
        } catch (dimErr) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: "Could not read image dimensions — file may be corrupted, or in a format we don't support. Please use a JPEG or PNG photo." });
        }

        // Smaller side must clear the minimum, whichever axis it's on —
        // sidesteps EXIF-orientation issues entirely, since we're not
        // asserting which axis is "supposed" to be longer.
        const { width, height } = dimensions;
        const shortSide = Math.min(width, height);
        const longSide = Math.max(width, height);
        if (shortSide < ID_PHOTO_MIN_WIDTH || longSide < ID_PHOTO_MIN_HEIGHT) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({
                error: `ID photo is too small (yours was ${width}×${height}px). Please use a clearer, higher-resolution photo.`
            });
        }

        const filePath = `/uploads/${req.file.filename}`;

        // Students no longer set id_photo_url directly — this creates a
        // pending request instead, which only becomes the official photo
        // once a homeroom teacher approves it. If a pending request from
        // this student already exists, replace it (and clean up its old
        // file) rather than piling up duplicates.
        const [existingPending] = await pool.query(
            `SELECT request_id, requested_photo_url FROM id_photo_change_requests
             WHERE student_id = ? AND school_id = ? AND status = 'pending'`,
            [req.user.user_id, req.user.school_id]
        );

        if (existingPending.length > 0) {
            const oldPath = path.join(__dirname, 'uploads', path.basename(existingPending[0].requested_photo_url));
            fs.unlink(oldPath, () => {}); // best-effort cleanup, don't fail the request over it
            await pool.query(
                'UPDATE id_photo_change_requests SET requested_photo_url = ?, requested_at = NOW() WHERE request_id = ?',
                [filePath, existingPending[0].request_id]
            );
        } else {
            await pool.query(
                `INSERT INTO id_photo_change_requests (student_id, school_id, requested_photo_url, status)
                 VALUES (?, ?, ?, 'pending')`,
                [req.user.user_id, req.user.school_id, filePath]
            );
        }

        res.json({ status: 'pending', requested_photo_url: filePath });
    } catch (err) {
        console.error("/api/student/upload-id-photo error:", err);
        res.status(500).json({ error: "Could not submit your request" });
    }
});

app.get('/api/student/id-photo-request-status', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT request_id, requested_photo_url, status, rejection_reason, requested_at, reviewed_at
             FROM id_photo_change_requests
             WHERE student_id = ? AND school_id = ?
             ORDER BY requested_at DESC LIMIT 1`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(rows.length > 0 ? rows[0] : { status: 'none' });
    } catch (err) {
        console.error("/api/student/id-photo-request-status error:", err);
        res.status(500).json({ error: "Could not load request status" });
    }
});

// --- Certificate requests ---
// A student can't just download their certificate once the underlying
// data is ready — they submit a request, and download only unlocks once
// a homeroom teacher approves it. The server re-checks "ready" itself
// rather than trusting the client, same as the existing readiness logic.
app.post('/api/student/request-certificate', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const terms = await getCertificateTerms(req.user.user_id, req.user.school_id);
        if (terms.length === 0) {
            return res.status(400).json({ error: "No marks history yet — nothing to request a certificate for." });
        }
        if (!isCertificateReady(terms)) {
            return res.status(400).json({ error: "Not every term has been synced by your homeroom teacher yet — you can request a certificate once they all are." });
        }

        const [existing] = await pool.query(
            `SELECT request_id, status FROM certificate_requests
             WHERE student_id = ? AND school_id = ? ORDER BY requested_at DESC LIMIT 1`,
            [req.user.user_id, req.user.school_id]
        );
        // Already pending or approved — don't create a duplicate, just
        // report back the existing state.
        if (existing.length > 0 && existing[0].status !== 'rejected') {
            return res.json({ status: existing[0].status, request_id: existing[0].request_id });
        }

        const [result] = await pool.query(
            `INSERT INTO certificate_requests (student_id, school_id, status) VALUES (?, ?, 'pending')`,
            [req.user.user_id, req.user.school_id]
        );
        res.json({ status: 'pending', request_id: result.insertId });
    } catch (err) {
        console.error("/api/student/request-certificate error:", err);
        res.status(500).json({ error: "Could not submit your request" });
    }
});

app.get('/api/student/certificate-request-status', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT request_id, status, rejection_reason, requested_at, reviewed_at
             FROM certificate_requests
             WHERE student_id = ? AND school_id = ?
             ORDER BY requested_at DESC LIMIT 1`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(rows.length > 0 ? rows[0] : { status: 'none' });
    } catch (err) {
        console.error("/api/student/certificate-request-status error:", err);
        res.status(500).json({ error: "Could not load request status" });
    }
});

// --- Absence / permission requests ---
// Requires a new table — run this migration if it doesn't exist yet:
//   CREATE TABLE absence_requests (
//     request_id INT AUTO_INCREMENT PRIMARY KEY,
//     student_id VARCHAR(50) NOT NULL,
//     school_id INT NOT NULL,
//     date_from DATE NOT NULL,
//     date_to DATE NOT NULL,
//     reason TEXT NOT NULL,
//     attachment_url VARCHAR(255) NULL,
//     status ENUM('pending','approved','rejected','escalated') NOT NULL DEFAULT 'pending',
//     rejection_reason VARCHAR(255) NULL,
//     escalated_by VARCHAR(50) NULL,
//     escalated_at DATETIME NULL,
//     escalation_note TEXT NULL,
//     reviewed_by VARCHAR(50) NULL,   -- whoever made the FINAL call — the
//                                     -- homeroom teacher for a direct
//                                     -- approve/reject, or the admin who
//                                     -- decided an escalated case
//     reviewed_at DATETIME NULL,
//     requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     INDEX idx_student (student_id, school_id)
//   );
//
// A student can submit this either BEFORE an absence (planned leave, e.g.
// a scheduled hospital visit) or AFTER one (explaining an absence that
// already happened, e.g. malaria) — date_from/date_to just describe which
// day(s) it covers, with no constraint on being in the past or future.
//
// Approval authority is capped: a homeroom teacher can approve/reject a
// request up to MAX_HOMEROOM_ABSENCE_DAYS on their own. Anything longer
// is outside their authority to grant — they escalate it instead, which
// hands it to school administration (Academic VP or similar admin_users
// account) to make the actual call. Rejection has no such cap: a
// homeroom teacher can reject a request of any length on their own,
// since rejecting doesn't require the extra authority approving a long
// absence does.
//
// Once approved (by either party), those days are excluded from the
// "absent days" count used on the certificate — see countAbsentDays()'s
// excusedSet, defined earlier in this file.
const MAX_HOMEROOM_ABSENCE_DAYS = 3;
function absenceRequestSpanDays(date_from, date_to) {
    const ms = new Date(date_to) - new Date(date_from);
    return Math.round(ms / 86400000) + 1; // inclusive of both endpoints
}

// Shared by every decision path that needs to tell a student something
// happened to a request of theirs (absence approve/reject/escalate, mark
// appeal approve/reject, etc.) — files a notification into the same
// student_notifications table/UI already used for assessment reminders,
// so the student doesn't have to keep re-checking a status page to find
// out. assessment_type is reused loosely here as a free-form type tag
// rather than a real assessment; assessmentLabel() on the frontend
// already falls back to a readable label for any type it has no
// translation for.
async function notifyStudent(student_id, school_id, sent_by, notifType, message) {
    const [studentRows] = await pool.query(
        'SELECT class_level, section, stream FROM students WHERE student_id = ? AND school_id = ?',
        [student_id, school_id]
    );
    if (studentRows.length === 0) return; // best-effort — don't fail the approval/rejection over this
    const { class_level, section, stream } = studentRows[0];
    await pool.query(
        `INSERT INTO student_notifications (student_id, school_id, sent_by, assessment_type, message, section, class_level, stream)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [student_id, school_id, sent_by, notifType, message, section, class_level, stream]
    );
}

app.post('/api/student/absence-requests', requireAuth, requireRole('students'), handleUploadError(upload.single('attachment')), async (req, res) => {
    const { date_from, date_to, reason } = req.body;
    if (!date_from || !date_to || !reason?.trim()) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "date_from, date_to, and reason are all required." });
    }
    if (new Date(date_to) < new Date(date_from)) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "date_to can't be before date_from." });
    }
    if (req.file && !req.file.mimetype.startsWith('image/') && req.file.mimetype !== 'application/pdf') {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "Attachment must be an image or a PDF." });
    }

    try {
        if (req.file) {
            const converted = await convertHeicIfNeeded(req.file);
            if (converted) req.file = converted;
        }
        const attachmentPath = req.file ? `/uploads/${req.file.filename}` : null;

        const [result] = await pool.query(
            `INSERT INTO absence_requests (student_id, school_id, date_from, date_to, reason, attachment_url, status)
             VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
            [req.user.user_id, req.user.school_id, date_from, date_to, reason.trim(), attachmentPath]
        );
        res.json({ message: "Absence request submitted.", request_id: result.insertId, status: 'pending' });
    } catch (err) {
        console.error("/api/student/absence-requests POST error:", err);
        res.status(500).json({ error: "Could not submit your absence request" });
    }
});

app.get('/api/student/absence-requests', requireAuth, requireRole('students'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT request_id, date_from, date_to, reason, attachment_url, status, rejection_reason,
                    escalated_at, requested_at, reviewed_at
             FROM absence_requests
             WHERE student_id = ? AND school_id = ?
             ORDER BY requested_at DESC`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/student/absence-requests GET error:", err);
        res.status(500).json({ error: "Could not load your absence requests" });
    }
});

// --- News & Announcements ---
// Read access is open to every authenticated role at the school (students,
// teachers, admin, registrar) — this is meant to be a shared community
// hub, but it still requires login. Multi-tenant: scoped strictly to
// req.user.school_id from the verified session, never a URL parameter,
// so a logged-in student can only ever see their own school's news, and
// nobody can view any school's announcements without an account there.
// Posting is restricted to admin_users only.
//
// NOTE: same limitation as attendance — admin_users has no title/role
// column visible to this middleware yet, so today ANY admin_users account
// can post, not specifically the Principal. Tell me if/when there's a
// title column to check and I'll tighten this to Principal-only.
//
// Every post (announcement or gallery item) is tagged with the language
// it was written in, since this school's community reads a mix of
// English, Amharic, Nuer, and Anuak. Validated against a fixed list
// server-side rather than trusting whatever string the client sends.
const ALLOWED_LANGUAGES = ['english', 'amharic', 'nuer', 'anuak'];
function normalizeLanguage(input) {
    const lang = (input || '').toString().trim().toLowerCase();
    return ALLOWED_LANGUAGES.includes(lang) ? lang : 'english';
}

app.get('/api/announcements', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT announcement_id, title, body, language, posted_at
             FROM school_announcements
             WHERE school_id = ?
             ORDER BY posted_at DESC`,
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/announcements error:", err);
        res.status(500).json({ error: "Could not load announcements" });
    }
});

app.post('/api/announcements', requireAuth, requireRole('admin_users'), async (req, res) => {
    const { title, body, language } = req.body;
    if (!title || !body) {
        return res.status(400).json({ error: "Both a title and body are required" });
    }
    const lang = normalizeLanguage(language);
    try {
        const [result] = await pool.query(
            `INSERT INTO school_announcements (school_id, title, body, language, posted_by)
             VALUES (?, ?, ?, ?, ?)`,
            [req.user.school_id, title, body, lang, req.user.user_id]
        );
        res.json({ message: "Announcement posted", announcement_id: result.insertId, language: lang });
    } catch (err) {
        console.error("POST /api/announcements error:", err);
        res.status(500).json({ error: "Could not post announcement" });
    }
});

app.delete('/api/announcements/:id', requireAuth, requireRole('admin_users'), async (req, res) => {
    try {
        const [result] = await pool.query(
            'DELETE FROM school_announcements WHERE announcement_id = ? AND school_id = ?',
            [req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Announcement not found" });
        }
        res.json({ message: "Announcement deleted" });
    } catch (err) {
        console.error("DELETE /api/announcements error:", err);
        res.status(500).json({ error: "Could not delete announcement" });
    }
});

// --- School Gallery ---
// Part of "School Hub" alongside News & Announcements — functions as a
// general community feed now, not strictly photo-only: a post needs
// EITHER body text OR a photo (or both), so admin can share a quick
// text update without being forced to attach an image. Same access
// model as announcements: any authenticated role can view, only
// admin_users can post/delete. Reuses the same `upload` multer instance
// already used for profile/ID/avatar photos — the photo field is
// optional here, unlike those routes.
app.get('/api/gallery', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT photo_id, image_url, body, language, posted_at
             FROM school_gallery
             WHERE school_id = ?
             ORDER BY posted_at DESC`,
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/gallery error:", err);
        res.status(500).json({ error: "Could not load gallery" });
    }
});

app.post('/api/gallery', requireAuth, requireRole('admin_users'), handleUploadError(upload.single('photo')), async (req, res) => {
    try {
        const { body, language } = req.body;
        const hasText = body && body.trim().length > 0;

        if (!req.file && !hasText) {
            return res.status(400).json({ error: "Post needs either text or a photo." });
        }
        if (req.file && !req.file.mimetype.startsWith('image/')) {
            return res.status(400).json({ error: "Photo must be an image file (JPEG, PNG, GIF, or WEBP)." });
        }
        if (req.file) {
            const converted = await convertHeicIfNeeded(req.file);
            if (converted) req.file = converted;
        }

        const lang = normalizeLanguage(language);
        const filePath = req.file ? `/uploads/${req.file.filename}` : null;
        const [result] = await pool.query(
            `INSERT INTO school_gallery (school_id, image_url, body, language, posted_by)
             VALUES (?, ?, ?, ?, ?)`,
            [req.user.school_id, filePath, hasText ? body.trim() : null, lang, req.user.user_id]
        );
        res.json({ photo_id: result.insertId, image_url: filePath, body: hasText ? body.trim() : null, language: lang });
    } catch (err) {
        console.error("POST /api/gallery error:", err);
        res.status(500).json({ error: "Could not post" });
    }
});

app.delete('/api/gallery/:id', requireAuth, requireRole('admin_users'), async (req, res) => {
    try {
        const [result] = await pool.query(
            'DELETE FROM school_gallery WHERE photo_id = ? AND school_id = ?',
            [req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Photo not found" });
        res.json({ message: "Photo deleted" });
    } catch (err) {
        console.error("DELETE /api/gallery error:", err);
        res.status(500).json({ error: "Could not delete photo" });
    }
});

// --- School Hub stats ---
// Deliberately separate from /api/student-stats: that endpoint narrows to
// a teacher's own assigned classes when called by a teacher, which is
// right for a class roster page but wrong for a school-wide landing page.
// This one is always the whole school, regardless of who's asking —
// scoped by req.user.school_id, same as everything else here.
app.get('/api/school/stats', requireAuth, async (req, res) => {
    try {
        const [[studentRow]] = await pool.query(
            'SELECT COUNT(*) as total FROM students WHERE school_id = ?',
            [req.user.school_id]
        );
        const [[teacherRow]] = await pool.query(
            'SELECT COUNT(*) as total FROM teachers WHERE school_id = ?',
            [req.user.school_id]
        );
        res.json({
            student_count: studentRow.total || 0,
            teacher_count: teacherRow.total || 0
        });
    } catch (err) {
        console.error("/api/school/stats error:", err);
        res.status(500).json({ error: "Could not load school stats" });
    }
});

app.get('/api/student/:id', requireAuth, async (req, res) => {
    // A logged-in student could otherwise pass any classmate's ID here and
    // get their full record (SELECT *) back — only their own is allowed.
    if (req.user.role === 'students' && String(req.params.id) !== String(req.user.user_id)) {
        return res.status(403).json({ error: "You can only view your own record." });
    }
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
    if (req.user.role === 'students' && String(req.params.id) !== String(req.user.user_id)) {
        return res.status(403).json({ error: "You can only view your own progress." });
    }
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
    // Full-roster endpoint — never appropriate for a student caller.
    if (req.user.role === 'students') {
        return res.status(403).json({ error: "You don't have permission to do this." });
    }
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
    if (req.user.role === 'students' && String(req.params.student_id) !== String(req.user.user_id)) {
        return res.status(403).json({ error: "You can only view your own marks." });
    }
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

        const converted = await convertHeicIfNeeded(req.file);
        if (converted) req.file = converted;

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

app.post('/api/student/update-password', requireAuth, requireRole('students'), async (req, res) => {
    const { currentPass, newPass } = req.body;

    if (!currentPass || !newPass) {
        return res.status(400).json({ error: "Current and new password are both required" });
    }
    if (newPass.length < 4) {
        return res.status(400).json({ error: "New password must be at least 4 characters" });
    }

    try {
        const [rows] = await pool.query(
            'SELECT security_password FROM students WHERE student_id = ? AND school_id = ?',
            [req.user.user_id, req.user.school_id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Student not found" });
        }

        const stored = rows[0].security_password;
        const match = await bcrypt.compare(currentPass, stored);
        if (!match) {
            return res.status(401).json({ error: "Current password incorrect" });
        }

        const hashed = await bcrypt.hash(newPass, 10);
        await pool.query(
            'UPDATE students SET security_password = ? WHERE student_id = ? AND school_id = ?',
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
            `SELECT t.full_name, t.teacher_id, t.contact_number, t.email, t.additional_role, t.avatar_url,
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
            avatar_url: rows[0].avatar_url || null,
            streams: [...new Set(rows.map(r => r.stream).filter(Boolean))],
            subjects: [...new Set(rows.map(r => r.subject_name).filter(Boolean))]
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Data for the "My ID" page — the teacher's own printable ID card.
// Combines identity/photo, department (homeroom/subject stream), and the
// school's address fields so the card can be rendered without the client
// having to stitch together /api/teacher/full-profile + a separate school
// lookup.
app.get('/api/teacher/id-card', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT t.full_name, t.teacher_id, t.contact_number, t.email, t.avatar_url, t.additional_role,
                    ta.stream, s.subject_name,
                    sc.school_name, sc.zone, sc.woreda, sc.region, sc.moe_school_code
             FROM teachers t
             LEFT JOIN teacher_assignments ta ON t.teacher_id = ta.teacher_id AND t.school_id = ta.school_id
             LEFT JOIN subjects s ON ta.subject_id = s.subject_id AND ta.school_id = s.school_id
             LEFT JOIN schools sc ON sc.id = t.school_id
             WHERE t.teacher_id = ? AND t.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Teacher not found" });

        const row0 = rows[0];
        const streams = [...new Set(rows.map(r => r.stream).filter(Boolean))];
        const subjects = [...new Set(rows.map(r => r.subject_name).filter(Boolean))];
        const schoolAddress = [row0.zone, row0.woreda, row0.region].filter(Boolean).join(', ') || null;

        // No academic-year concept exists yet (see getSchoolYear() below) —
        // cards are shown valid through the end of the current calendar
        // year, same convention as the rest of the app.
        const validYear = new Date().getFullYear();

        res.json({
            full_name: row0.full_name,
            teacher_id: row0.teacher_id,
            contact_number: row0.contact_number,
            email: row0.email,
            avatar_url: row0.avatar_url || null,
            department: streams.length > 0 ? streams.join(', ') : (row0.additional_role || null),
            subjects,
            school_name: row0.school_name,
            school_address: schoolAddress,
            moe_school_code: row0.moe_school_code,
            valid_until: `12/31/${validYear}`
        });
    } catch (err) {
        console.error("/api/teacher/id-card error:", err);
        res.status(500).json({ error: "Could not load ID card data" });
    }
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

        // Snapshot each of these students' class/section/stream for this
        // term — this is the one place in the codebase that already knows
        // it at push time, and it's what the Certificate feature needs to
        // check historical terms correctly once a student is promoted.
        // Keyed on (student_id, class_level, term) rather than just
        // (student_id, term) — "Semester 1" is reused every year, so
        // class_level is what actually distinguishes Grade 9 from Grade 10.
        const historyRows = totals.map(t => [t.student_id, req.user.school_id, class_level, section, stream, term]);
        await pool.query(
            `INSERT INTO student_enrollment_history (student_id, school_id, class_level, section, stream, term)
             VALUES ?
             ON DUPLICATE KEY UPDATE section = VALUES(section), stream = VALUES(stream)`,
            [historyRows]
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

// Single-student full report card, grouped by class level. Each class
// level lists every subject pushed for it (Semester 1 total, Semester 2
// total, year average), plus the student's OVERALL average per semester
// and for the year. Grouping by class_level (rather than flattening by
// subject name alone) matters because a subject name can repeat across
// grades — e.g. "Math" in both Grade 9 and Grade 10 — and pairing
// Semester 1/2 across two different years would silently produce a
// meaningless "year average". A class level only gets semester/year
// averages once that semester has actually been synced by homeroom (not
// just partially pushed) — see semester_1_synced / semester_2_synced.
app.get('/api/homeroom/student-report/:student_id', requireAuth, requireRole('teachers'), async (req, res) => {
    try {
        // Only the student's CURRENT homeroom teacher can pull their full
        // report — without this check, any authenticated teacher could
        // view any student's grades just by knowing their student_id.
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }
        const [studentRows] = await pool.query(
            `SELECT student_id FROM students
             WHERE student_id = ? AND school_id = ? AND class_level = ? AND section = ? AND stream = ?`,
            [req.params.student_id, req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        if (studentRows.length === 0) {
            return res.status(403).json({ error: "This student is not in your homeroom section." });
        }

        const [rows] = await pool.query(
            `SELECT s.subject_name, pr.class_level, pr.section, pr.stream, pr.term, prs.total_score
             FROM pushed_report_scores prs
             JOIN pushed_reports pr ON pr.push_id = prs.push_id AND pr.school_id = prs.school_id
             JOIN subjects s ON s.subject_id = pr.subject_id AND s.school_id = pr.school_id
             WHERE prs.student_id = ? AND prs.school_id = ?
             ORDER BY pr.class_level, s.subject_name, pr.term`,
            [req.params.student_id, req.user.school_id]
        );

        const byClassLevel = {};
        rows.forEach(row => {
            if (!byClassLevel[row.class_level]) {
                byClassLevel[row.class_level] = { section: row.section, stream: row.stream, subjects: {} };
            }
            const bucket = byClassLevel[row.class_level].subjects;
            if (!bucket[row.subject_name]) bucket[row.subject_name] = {};
            bucket[row.subject_name][row.term] = Number(row.total_score);
        });

        const report = await Promise.all(Object.keys(byClassLevel).sort().map(async (class_level) => {
            const { section, stream, subjects: subjectMap } = byClassLevel[class_level];

            const subjects = Object.keys(subjectMap).sort().map(subject_name => {
                const s1 = subjectMap[subject_name]['Semester 1'] ?? null;
                const s2 = subjectMap[subject_name]['Semester 2'] ?? null;
                return {
                    subject_name,
                    semester_1: s1,
                    semester_2: s2,
                    year_average: yearAverage(s1, s2)
                };
            });

            const [syncRows] = await pool.query(
                `SELECT term FROM pushed_marks_reports
                 WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term IN (?, ?)`,
                [req.user.school_id, class_level, section, stream, ...TERMS]
            );
            const syncedTerms = new Set(syncRows.map(r => r.term));
            const semester_1_synced = syncedTerms.has('Semester 1');
            const semester_2_synced = syncedTerms.has('Semester 2');

            // Rank against the rest of this student's section — only once
            // that term (or, for year rank, both terms) is actually synced.
            const [s1Ranked, s2Ranked, yearRanked] = await Promise.all([
                semester_1_synced
                    ? rankStudents(await getSectionTermAverages(req.user.school_id, class_level, section, stream, 'Semester 1'))
                    : new Map(),
                semester_2_synced
                    ? rankStudents(await getSectionTermAverages(req.user.school_id, class_level, section, stream, 'Semester 2'))
                    : new Map(),
                (semester_1_synced && semester_2_synced)
                    ? rankStudents(await getSectionYearAverages(req.user.school_id, class_level, section, stream))
                    : new Map()
            ]);
            const mine1 = s1Ranked.get(String(req.params.student_id));
            const mine2 = s2Ranked.get(String(req.params.student_id));
            const mineYear = yearRanked.get(String(req.params.student_id));

            return {
                class_level,
                section,
                stream,
                subjects,
                semester_1_synced,
                semester_2_synced,
                semester_1_average: overallAverage(subjects.map(s => s.semester_1)),
                semester_2_average: overallAverage(subjects.map(s => s.semester_2)),
                year_average: overallAverage(subjects.map(s => s.year_average)),
                semester_1_rank: mine1?.rank ?? null,
                semester_1_class_size: mine1?.class_size ?? null,
                semester_2_rank: mine2?.rank ?? null,
                semester_2_class_size: mine2?.class_size ?? null,
                year_rank: mineYear?.rank ?? null,
                year_class_size: mineYear?.class_size ?? null
            };
        }));

        res.json(report);
    } catch (err) {
        console.error("student-report error:", err);
        res.status(500).json({ error: "Could not load student report" });
    }
});

// Whole-section table for principal reporting / CSV export: rows = every
// student in the homeroom teacher's section, columns = every subject that
// has EVER been pushed for that section (across both terms), each split
// into S1 / S2 / Year Avg, plus each student's own overall average per
// semester and for the year. Subjects not yet pushed are simply absent —
// per your earlier answer, only pushed subjects appear, nothing blank-padded
// for subjects that were never pushed at all. (A subject pushed for only
// one term DOES show, with the other term's cell empty.) semester_1_synced
// / semester_2_synced reflect whether homeroom has actually forwarded that
// semester to Academic VP yet (100% of subjects pushed) — the per-subject
// and overall numbers are still shown either way, so you can review before
// syncing, but the flags let the UI mark unsynced figures as provisional.
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

        const [syncRows] = await pool.query(
            `SELECT term FROM pushed_marks_reports
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term IN (?, ?)`,
            [req.user.school_id, class_level, section, stream, ...TERMS]
        );
        const syncedTerms = new Set(syncRows.map(r => r.term));

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
                const s1 = entry['Semester 1'] ?? null;
                const s2 = entry['Semester 2'] ?? null;
                subjects[name] = {
                    semester_1: s1,
                    semester_2: s2,
                    year_average: yearAverage(s1, s2)
                };
            });
            const subjectValues = Object.values(subjects);
            return {
                student_id: student.student_id,
                full_name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' '),
                subjects,
                semester_1_average: overallAverage(subjectValues.map(s => s.semester_1)),
                semester_2_average: overallAverage(subjectValues.map(s => s.semester_2)),
                year_average: overallAverage(subjectValues.map(s => s.year_average))
            };
        });

        // Rank is computed from these same averages — no extra query
        // needed, since this endpoint already has every student in the
        // section in memory. Only computed for terms that are actually
        // synced (see semester_1_synced/semester_2_synced above) — an
        // unsynced term's averages could still be based on partial pushes.
        const s1Ranks = syncedTerms.has('Semester 1')
            ? rankStudents(report.map(r => ({ student_id: r.student_id, score: r.semester_1_average })))
            : new Map();
        const s2Ranks = syncedTerms.has('Semester 2')
            ? rankStudents(report.map(r => ({ student_id: r.student_id, score: r.semester_2_average })))
            : new Map();
        const yearRanks = (syncedTerms.has('Semester 1') && syncedTerms.has('Semester 2'))
            ? rankStudents(report.map(r => ({ student_id: r.student_id, score: r.year_average })))
            : new Map();

        report.forEach(r => {
            const id = String(r.student_id);
            r.semester_1_rank = s1Ranks.get(id)?.rank ?? null;
            r.semester_2_rank = s2Ranks.get(id)?.rank ?? null;
            r.year_rank = yearRanks.get(id)?.rank ?? null;
        });

        res.json({
            subject_columns: subjectNames,
            semester_1_synced: syncedTerms.has('Semester 1'),
            semester_2_synced: syncedTerms.has('Semester 2'),
            // Each figure is scoped to however many students actually had
            // comparable (non-null) scores for that specific term/year —
            // usually the same as the section's full roster once synced,
            // but not guaranteed (e.g. a student who joined mid-year).
            semester_1_class_size: s1Ranks.size ? [...s1Ranks.values()][0].class_size : null,
            semester_2_class_size: s2Ranks.size ? [...s2Ranks.values()][0].class_size : null,
            year_class_size: yearRanks.size ? [...yearRanks.values()][0].class_size : null,
            students: report
        });
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

// Homeroom teacher resets a forgotten student password back to the school
// default (1234). Scoped the same way as the textbook routes above — the
// caller must actually be a homeroom teacher, and the student must belong
// to that teacher's own section, class level, and stream. The student is
// expected to log in with the default and change it themselves afterward
// via /api/student/update-password.
const DEFAULT_STUDENT_PASSWORD = '1234';
app.post('/api/homeroom/reset-student-password', requireAuth, async (req, res) => {
    const { student_id } = req.body;
    if (!student_id) {
        return res.status(400).json({ error: "student_id is required" });
    }

    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }

        const [studentRows] = await pool.query(
            'SELECT student_id, first_name, last_name FROM students WHERE student_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?',
            [student_id, homeroom.class_level, homeroom.section, homeroom.stream, req.user.school_id]
        );
        if (studentRows.length === 0) {
            return res.status(403).json({ error: "This student is not in your homeroom section." });
        }

        const hashed = await bcrypt.hash(DEFAULT_STUDENT_PASSWORD, 10);
        await pool.query(
            'UPDATE students SET security_password = ? WHERE student_id = ? AND school_id = ?',
            [hashed, student_id, req.user.school_id]
        );

        const student = studentRows[0];
        res.json({
            message: `Password reset for ${student.first_name} ${student.last_name}. They can log in with the default password and should change it from their Profile page.`,
            student_id: student.student_id,
            default_password: DEFAULT_STUDENT_PASSWORD
        });
    } catch (err) {
        console.error("reset-student-password error:", err);
        res.status(500).json({ error: "Could not reset password" });
    }
});

// --- Homeroom: Class Monitor designation ---
// Requires a new column — run this migration if it doesn't exist yet:
//   ALTER TABLE students ADD COLUMN is_class_monitor BOOLEAN NOT NULL DEFAULT FALSE;
// No hard cap enforced here — "at least 2 per section" is guidance, not a
// rule, so a homeroom teacher can name as many (or as few) as they want.
// The flag only takes effect on that student's NEXT login (it's baked
// into the JWT at login time), same caveat as requirePrincipal/title.
app.get('/api/homeroom/section-roster', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [students] = await pool.query(
            `SELECT student_id, first_name, last_name, is_class_monitor FROM students
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ?
             ORDER BY first_name, last_name`,
            [req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        res.json(students);
    } catch (err) {
        console.error("/api/homeroom/section-roster error:", err);
        res.status(500).json({ error: "Could not load section roster" });
    }
});

app.post('/api/homeroom/set-class-monitor', requireAuth, async (req, res) => {
    const { student_id, is_class_monitor } = req.body;
    if (!student_id || typeof is_class_monitor !== 'boolean') {
        return res.status(400).json({ error: "student_id and a boolean is_class_monitor are required." });
    }
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [result] = await pool.query(
            `UPDATE students SET is_class_monitor = ?
             WHERE student_id = ? AND school_id = ? AND class_level = ? AND section = ? AND stream = ?`,
            [is_class_monitor, student_id, req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        if (result.affectedRows === 0) {
            return res.status(403).json({ error: "This student is not in your homeroom section." });
        }
        res.json({ message: is_class_monitor ? "Set as Class Monitor." : "Removed as Class Monitor.", student_id, is_class_monitor });
    } catch (err) {
        console.error("/api/homeroom/set-class-monitor error:", err);
        res.status(500).json({ error: "Could not update Class Monitor status" });
    }
});

// --- Homeroom: My Class attendance ---
// Consistent with the QR check-in model earlier in this file: a
// student_attendance row is only ever written with status 'present' —
// there is no 'absent' status to write. A student with no row for today
// simply hasn't been checked in yet, and every day-counting feature
// (countAbsentDays, the streak, etc.) already treats a missing row as
// absent. This endpoint gives a homeroom teacher a full roster of their
// own section with today's present/not-yet-present status, and a way to
// mark a student present by hand (e.g. they forgot their ID card) —
// without inventing a second status those other features don't expect.
app.get('/api/homeroom/attendance-today', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [students] = await pool.query(
            `SELECT student_id, first_name, last_name FROM students
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ?
             ORDER BY first_name, last_name`,
            [req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );

        const today = toDateOnly(new Date());
        let presentMap = new Map();
        if (students.length > 0) {
            const [presentRows] = await pool.query(
                `SELECT student_id, marked_by FROM student_attendance
                 WHERE school_id = ? AND attendance_date = ? AND student_id IN (?)`,
                [req.user.school_id, today, students.map(s => s.student_id)]
            );
            presentMap = new Map(presentRows.map(r => [r.student_id, r.marked_by]));
        }

        const roster = students.map(s => ({
            student_id: s.student_id,
            first_name: s.first_name,
            last_name: s.last_name,
            present: presentMap.has(s.student_id),
            marked_by_me: presentMap.get(s.student_id) === req.user.user_id
        }));

        res.json({
            class_level: homeroom.class_level,
            section: homeroom.section,
            stream: homeroom.stream,
            date: today,
            total: roster.length,
            present_count: roster.filter(r => r.present).length,
            roster
        });
    } catch (err) {
        console.error("/api/homeroom/attendance-today error:", err);
        res.status(500).json({ error: "Could not load today's attendance" });
    }
});

// Manual equivalent of /api/attendance/checkin for a homeroom teacher who
// doesn't have (or doesn't want to use) a scanner handy — same
// same-day-only, one-row-per-student behavior, just triggered by tapping
// a name instead of scanning a QR code.
app.post('/api/homeroom/mark-present', requireAuth, async (req, res) => {
    const { student_id } = req.body;
    if (!student_id) return res.status(400).json({ error: "student_id is required" });
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [studentRows] = await pool.query(
            `SELECT student_id, first_name, last_name FROM students
             WHERE student_id = ? AND school_id = ? AND class_level = ? AND section = ? AND stream = ?`,
            [student_id, req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        if (studentRows.length === 0) {
            return res.status(403).json({ error: "This student isn't in your homeroom section." });
        }
        const student = studentRows[0];
        const today = toDateOnly(new Date());

        const [existing] = await pool.query(
            'SELECT attendance_id FROM student_attendance WHERE student_id = ? AND attendance_date = ?',
            [student_id, today]
        );
        if (existing.length > 0) {
            return res.json({
                message: `${student.first_name} ${student.last_name} was already checked in today`,
                already_checked_in: true,
                student_id
            });
        }

        await pool.query(
            `INSERT INTO student_attendance (student_id, school_id, attendance_date, status, marked_by)
             VALUES (?, ?, ?, 'present', ?)`,
            [student_id, req.user.school_id, today, req.user.user_id]
        );
        res.json({
            message: `Marked ${student.first_name} ${student.last_name} present`,
            already_checked_in: false,
            student_id
        });
    } catch (err) {
        console.error("/api/homeroom/mark-present error:", err);
        res.status(500).json({ error: "Could not mark attendance" });
    }
});

// Undo a manual present-mark made by mistake — same day only, mirroring
// the textbook "Undo Lost" pattern elsewhere in this file. Only removes
// today's row, so it can't be used to erase attendance history.
app.post('/api/homeroom/undo-present', requireAuth, async (req, res) => {
    const { student_id } = req.body;
    if (!student_id) return res.status(400).json({ error: "student_id is required" });
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [studentRows] = await pool.query(
            `SELECT student_id FROM students
             WHERE student_id = ? AND school_id = ? AND class_level = ? AND section = ? AND stream = ?`,
            [student_id, req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        if (studentRows.length === 0) {
            return res.status(403).json({ error: "This student isn't in your homeroom section." });
        }

        const today = toDateOnly(new Date());
        const [result] = await pool.query(
            'DELETE FROM student_attendance WHERE student_id = ? AND school_id = ? AND attendance_date = ?',
            [student_id, req.user.school_id, today]
        );
        res.json({ message: result.affectedRows > 0 ? "Attendance mark undone." : "No mark to undo.", student_id });
    } catch (err) {
        console.error("/api/homeroom/undo-present error:", err);
        res.status(500).json({ error: "Could not undo attendance mark" });
    }
});

// --- Homeroom: upload a student's official photo directly ---
// For when a student can't get a usable photo of their own (or asks their
// homeroom teacher to just handle it) — the teacher uploads one photo,
// which becomes students.id_photo_url directly (no approval step, since
// the teacher is the one performing the action). This is the single photo
// used for BOTH the student's ID card and their certificate — there's no
// separate "certificate photo" field, id_photo_url is it.
app.post('/api/homeroom/upload-student-photo', requireAuth, handleUploadError(upload.single('photo')), async (req, res) => {
    const { student_id } = req.body;
    try {
        if (!student_id) {
            if (req.file) fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: "student_id is required" });
        }
        if (!req.file) return res.status(400).json({ error: "No photo uploaded" });
        if (!req.file.mimetype.startsWith('image/')) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: "Photo must be an image file (JPEG, PNG, GIF, or WEBP)." });
        }

        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            fs.unlink(req.file.path, () => {});
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }

        const converted = await convertHeicIfNeeded(req.file);
        if (converted) req.file = converted;

        let dimensions;
        try {
            dimensions = sizeOf(req.file.path);
        } catch (dimErr) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: "Could not read image dimensions — file may be corrupted, or in a format we don't support. Please use a JPEG or PNG photo." });
        }
        const { width, height } = dimensions;
        const shortSide = Math.min(width, height);
        const longSide = Math.max(width, height);
        if (shortSide < ID_PHOTO_MIN_WIDTH || longSide < ID_PHOTO_MIN_HEIGHT) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({
                error: `Photo is too small (was ${width}×${height}px). Please use a clearer, higher-resolution photo.`
            });
        }

        const [studentRows] = await pool.query(
            'SELECT student_id, first_name, last_name, id_photo_url FROM students WHERE student_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?',
            [student_id, homeroom.class_level, homeroom.section, homeroom.stream, req.user.school_id]
        );
        if (studentRows.length === 0) {
            fs.unlink(req.file.path, () => {});
            return res.status(403).json({ error: "This student is not in your homeroom section." });
        }
        const student = studentRows[0];
        const filePath = `/uploads/${req.file.filename}`;

        await pool.query(
            'UPDATE students SET id_photo_url = ? WHERE student_id = ? AND school_id = ?',
            [filePath, student_id, req.user.school_id]
        );

        // Clean up the old photo file, if there was one, now that it's
        // been replaced.
        if (student.id_photo_url) {
            const oldPath = path.join(__dirname, 'uploads', path.basename(student.id_photo_url));
            fs.unlink(oldPath, () => {});
        }

        // Any pending self-submitted request from this student is now
        // moot — resolve it so it doesn't sit in the queue forever.
        await pool.query(
            `UPDATE id_photo_change_requests
             SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), requested_photo_url = ?
             WHERE student_id = ? AND school_id = ? AND status = 'pending'`,
            [req.user.user_id, filePath, student_id, req.user.school_id]
        );

        res.json({
            message: `Photo uploaded for ${student.first_name} ${student.last_name}. It's now their official photo for both their ID card and certificate.`,
            id_photo_url: filePath
        });
    } catch (err) {
        console.error("/api/homeroom/upload-student-photo error:", err);
        res.status(500).json({ error: "Could not upload this photo" });
    }
});

// --- Homeroom: ID photo change requests ---
// Students submit a request (with the new photo already uploaded) rather
// than setting their own id_photo_url directly. Approving here is what
// actually writes it to students.id_photo_url; rejecting just records a
// reason and leaves the student's official photo untouched.
app.get('/api/homeroom/id-photo-requests', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [rows] = await pool.query(
            `SELECT r.request_id, r.student_id, r.requested_photo_url, r.status, r.requested_at,
                    st.first_name, st.last_name, st.id_photo_url AS current_photo_url
             FROM id_photo_change_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             WHERE r.school_id = ? AND r.status = 'pending'
               AND st.class_level = ? AND st.section = ? AND st.stream = ?
             ORDER BY r.requested_at ASC`,
            [req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/homeroom/id-photo-requests error:", err);
        res.status(500).json({ error: "Could not load requests" });
    }
});

app.post('/api/homeroom/id-photo-requests/:id/approve', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [rows] = await pool.query(
            `SELECT r.request_id, r.student_id, r.requested_photo_url
             FROM id_photo_change_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             WHERE r.request_id = ? AND r.school_id = ? AND r.status = 'pending'
               AND st.class_level = ? AND st.section = ? AND st.stream = ?`,
            [req.params.id, req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "Request not found, already reviewed, or not in your homeroom section." });
        }
        const request = rows[0];

        await pool.query(
            'UPDATE students SET id_photo_url = ? WHERE student_id = ? AND school_id = ?',
            [request.requested_photo_url, request.student_id, req.user.school_id]
        );
        await pool.query(
            `UPDATE id_photo_change_requests SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE request_id = ?`,
            [req.user.user_id, request.request_id]
        );
        res.json({ message: "Approved. This is now the student's official ID photo." });
    } catch (err) {
        console.error("/api/homeroom/id-photo-requests/:id/approve error:", err);
        res.status(500).json({ error: "Could not approve this request" });
    }
});

app.post('/api/homeroom/id-photo-requests/:id/reject', requireAuth, async (req, res) => {
    const { reason } = req.body;
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [result] = await pool.query(
            `UPDATE id_photo_change_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             SET r.status = 'rejected', r.reviewed_by = ?, r.reviewed_at = NOW(), r.rejection_reason = ?
             WHERE r.request_id = ? AND r.school_id = ? AND r.status = 'pending'
               AND st.class_level = ? AND st.section = ? AND st.stream = ?`,
            [req.user.user_id, reason || null, req.params.id, req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Request not found, already reviewed, or not in your homeroom section." });
        }
        res.json({ message: "Request rejected." });
    } catch (err) {
        console.error("/api/homeroom/id-photo-requests/:id/reject error:", err);
        res.status(500).json({ error: "Could not reject this request" });
    }
});

// --- Homeroom: absence / permission requests ---
app.get('/api/homeroom/absence-requests', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [rows] = await pool.query(
            `SELECT r.request_id, r.student_id, r.date_from, r.date_to, r.reason, r.attachment_url,
                    r.status, r.requested_at, st.first_name, st.last_name
             FROM absence_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             WHERE r.school_id = ? AND r.status = 'pending'
               AND st.class_level = ? AND st.section = ? AND st.stream = ?
             ORDER BY r.requested_at ASC`,
            [req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        // span_days/within_authority let the teacher's UI decide whether to
        // show Approve/Reject or just Escalate/Reject for each row, without
        // having to reimplement the day-math client-side.
        const withSpan = rows.map(r => {
            const span_days = absenceRequestSpanDays(r.date_from, r.date_to);
            return { ...r, span_days, within_homeroom_authority: span_days <= MAX_HOMEROOM_ABSENCE_DAYS };
        });
        res.json(withSpan);
    } catch (err) {
        console.error("/api/homeroom/absence-requests error:", err);
        res.status(500).json({ error: "Could not load absence requests" });
    }
});

app.post('/api/homeroom/absence-requests/:id/approve', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [rows] = await pool.query(
            `SELECT r.request_id, r.student_id, r.school_id, r.date_from, r.date_to
             FROM absence_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             WHERE r.request_id = ? AND r.school_id = ? AND r.status = 'pending'
               AND st.class_level = ? AND st.section = ? AND st.stream = ?`,
            [req.params.id, req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "Request not found, already reviewed, or not in your homeroom section." });
        }
        const request = rows[0];

        // A homeroom teacher's approval authority is capped — anything
        // longer needs to go to school administration instead. Checked
        // here too (not just hidden client-side), so the cap can't be
        // bypassed by calling this endpoint directly.
        const span_days = absenceRequestSpanDays(request.date_from, request.date_to);
        if (span_days > MAX_HOMEROOM_ABSENCE_DAYS) {
            return res.status(400).json({
                error: `This request covers ${span_days} days, more than you're able to approve directly (max ${MAX_HOMEROOM_ABSENCE_DAYS}). Escalate it to Admin instead.`,
                span_days,
                max_homeroom_days: MAX_HOMEROOM_ABSENCE_DAYS
            });
        }

        await pool.query(
            `UPDATE absence_requests SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE request_id = ?`,
            [req.user.user_id, request.request_id]
        );
        await notifyStudent(
            request.student_id, request.school_id, req.user.user_id, 'absence_approved',
            `Your absence request for ${request.date_from} to ${request.date_to} was approved by your homeroom teacher.`
        );
        res.json({ message: "Approved. These days won't count as unexcused absences." });
    } catch (err) {
        console.error("/api/homeroom/absence-requests/:id/approve error:", err);
        res.status(500).json({ error: "Could not approve this request" });
    }
});

app.post('/api/homeroom/absence-requests/:id/reject', requireAuth, async (req, res) => {
    const { reason } = req.body;
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [rows] = await pool.query(
            `SELECT r.request_id, r.student_id, r.school_id, r.date_from, r.date_to
             FROM absence_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             WHERE r.request_id = ? AND r.school_id = ? AND r.status = 'pending'
               AND st.class_level = ? AND st.section = ? AND st.stream = ?`,
            [req.params.id, req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "Request not found, already reviewed, or not in your homeroom section." });
        }
        const request = rows[0];

        // No day-span cap on rejection — a homeroom teacher can decline a
        // request of any length on their own; only *granting* a long
        // absence requires escalating to admin.
        await pool.query(
            `UPDATE absence_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = ? WHERE request_id = ?`,
            [req.user.user_id, reason || null, request.request_id]
        );
        await notifyStudent(
            request.student_id, request.school_id, req.user.user_id, 'absence_rejected',
            `Your absence request for ${request.date_from} to ${request.date_to} was rejected by your homeroom teacher.${reason ? ' Reason: ' + reason : ''}`
        );
        res.json({ message: "Request rejected." });
    } catch (err) {
        console.error("/api/homeroom/absence-requests/:id/reject error:", err);
        res.status(500).json({ error: "Could not reject this request" });
    }
});

// Hands a request to school administration when it's beyond a homeroom
// teacher's own approval authority (see MAX_HOMEROOM_ABSENCE_DAYS above).
// Doesn't decide anything itself — just moves it into the admin queue;
// /api/admin/absence-requests/:id/approve|reject makes the actual call.
app.post('/api/homeroom/absence-requests/:id/escalate', requireAuth, async (req, res) => {
    const { note } = req.body;
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [rows] = await pool.query(
            `SELECT r.request_id, r.student_id, r.school_id, r.date_from, r.date_to
             FROM absence_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             WHERE r.request_id = ? AND r.school_id = ? AND r.status = 'pending'
               AND st.class_level = ? AND st.section = ? AND st.stream = ?`,
            [req.params.id, req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "Request not found, already reviewed, or not in your homeroom section." });
        }
        const request = rows[0];

        await pool.query(
            `UPDATE absence_requests SET status = 'escalated', escalated_by = ?, escalated_at = NOW(), escalation_note = ? WHERE request_id = ?`,
            [req.user.user_id, note || null, request.request_id]
        );
        await notifyStudent(
            request.student_id, request.school_id, req.user.user_id, 'absence_escalated',
            `Your absence request for ${request.date_from} to ${request.date_to} needs review by school administration and has been forwarded to them.`
        );
        res.json({ message: "Escalated to Admin for review." });
    } catch (err) {
        console.error("/api/homeroom/absence-requests/:id/escalate error:", err);
        res.status(500).json({ error: "Could not escalate this request" });
    }
});

// --- Admin: escalated absence / permission requests ---
// Open to any admin_users account today (same relaxed gating as
// /api/admin/textbooks and the announcements/gallery endpoints) rather
// than a specific title like "Academic VP" — admin_users.title exists
// now (see requirePrincipal above) but only 'Principal' is currently a
// meaningful value anywhere in the app. If/when "Academic VP" becomes a
// real, populated title, swap requireRole('admin_users') here for a
// title check the same way requirePrincipal does.
app.get('/api/admin/absence-requests', requireAuth, requireRole('admin_users'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT r.request_id, r.student_id, r.date_from, r.date_to, r.reason, r.attachment_url,
                    r.escalated_at, r.escalation_note, st.first_name, st.last_name,
                    st.class_level, st.section, st.stream
             FROM absence_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             WHERE r.school_id = ? AND r.status = 'escalated'
             ORDER BY r.escalated_at ASC`,
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/admin/absence-requests error:", err);
        res.status(500).json({ error: "Could not load escalated absence requests" });
    }
});

app.post('/api/admin/absence-requests/:id/approve', requireAuth, requireRole('admin_users'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT request_id, student_id, school_id, date_from, date_to FROM absence_requests
             WHERE request_id = ? AND school_id = ? AND status = 'escalated'`,
            [req.params.id, req.user.school_id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "Request not found or not currently escalated to Admin." });
        }
        const request = rows[0];

        await pool.query(
            `UPDATE absence_requests SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE request_id = ?`,
            [req.user.user_id, request.request_id]
        );
        await notifyStudent(
            request.student_id, request.school_id, req.user.user_id, 'absence_approved',
            `Your absence request for ${request.date_from} to ${request.date_to} was approved by school administration.`
        );
        res.json({ message: "Approved. These days won't count as unexcused absences." });
    } catch (err) {
        console.error("/api/admin/absence-requests/:id/approve error:", err);
        res.status(500).json({ error: "Could not approve this request" });
    }
});

app.post('/api/admin/absence-requests/:id/reject', requireAuth, requireRole('admin_users'), async (req, res) => {
    const { reason } = req.body;
    try {
        const [rows] = await pool.query(
            `SELECT request_id, student_id, school_id, date_from, date_to FROM absence_requests
             WHERE request_id = ? AND school_id = ? AND status = 'escalated'`,
            [req.params.id, req.user.school_id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "Request not found or not currently escalated to Admin." });
        }
        const request = rows[0];

        await pool.query(
            `UPDATE absence_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = ? WHERE request_id = ?`,
            [req.user.user_id, reason || null, request.request_id]
        );
        await notifyStudent(
            request.student_id, request.school_id, req.user.user_id, 'absence_rejected',
            `Your absence request for ${request.date_from} to ${request.date_to} was rejected by school administration.${reason ? ' Reason: ' + reason : ''}`
        );
        res.json({ message: "Request rejected." });
    } catch (err) {
        console.error("/api/admin/absence-requests/:id/reject error:", err);
        res.status(500).json({ error: "Could not reject this request" });
    }
});

// --- Homeroom: certificate requests ---
app.get('/api/homeroom/certificate-requests', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [rows] = await pool.query(
            `SELECT r.request_id, r.student_id, r.requested_at,
                    st.first_name, st.last_name
             FROM certificate_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             WHERE r.school_id = ? AND r.status = 'pending'
               AND st.class_level = ? AND st.section = ? AND st.stream = ?
             ORDER BY r.requested_at ASC`,
            [req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/homeroom/certificate-requests error:", err);
        res.status(500).json({ error: "Could not load requests" });
    }
});

app.post('/api/homeroom/certificate-requests/:id/approve', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [result] = await pool.query(
            `UPDATE certificate_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             SET r.status = 'approved', r.reviewed_by = ?, r.reviewed_at = NOW()
             WHERE r.request_id = ? AND r.school_id = ? AND r.status = 'pending'
               AND st.class_level = ? AND st.section = ? AND st.stream = ?`,
            [req.user.user_id, req.params.id, req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Request not found, already reviewed, or not in your homeroom section." });
        }
        res.json({ message: "Approved. The student can now download their certificate." });
    } catch (err) {
        console.error("/api/homeroom/certificate-requests/:id/approve error:", err);
        res.status(500).json({ error: "Could not approve this request" });
    }
});

app.post('/api/homeroom/certificate-requests/:id/reject', requireAuth, async (req, res) => {
    const { reason } = req.body;
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "You are not a homeroom teacher." });

        const [result] = await pool.query(
            `UPDATE certificate_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             SET r.status = 'rejected', r.reviewed_by = ?, r.reviewed_at = NOW(), r.rejection_reason = ?
             WHERE r.request_id = ? AND r.school_id = ? AND r.status = 'pending'
               AND st.class_level = ? AND st.section = ? AND st.stream = ?`,
            [req.user.user_id, reason || null, req.params.id, req.user.school_id, homeroom.class_level, homeroom.section, homeroom.stream]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Request not found, already reviewed, or not in your homeroom section." });
        }
        res.json({ message: "Request rejected." });
    } catch (err) {
        console.error("/api/homeroom/certificate-requests/:id/reject error:", err);
        res.status(500).json({ error: "Could not reject this request" });
    }
});

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
        const term_start_date = await getTermStartDate(req.user.school_id);
        const semester_status = await getSemesterStatus(req.user.school_id);
        res.json({ current_term: term, available_terms: TERMS, term_start_date, semester_status });
    } catch (err) {
        console.error("term/current error:", err);
        res.status(500).json({ error: "Could not load current term" });
    }
});

// This is the "Start Semester" button — Academic VP (or any admin_users
// account, per the loose gating noted elsewhere in this file) calls this
// to both (a) set which term new marks get stamped with, and (b) mark
// TODAY as the day counting starts for that term. That second part is
// what countAbsentDays(), the attendance heatmap calendar, and the
// streak all key off of — none of them will count a day before this
// timestamp, no matter how far back their own query window reaches.
// Pushing this again (e.g. correcting a mistake, or moving to Semester 2)
// resets the start date to today each time — the clock always reflects
// the most recent press of the button, not the first ever.
app.post('/api/term/set', requireAuth, requireRole('admin_users'), async (req, res) => {
    const { term } = req.body;
    if (!TERMS.includes(term)) {
        return res.status(400).json({ error: `term must be one of: ${TERMS.join(', ')}` });
    }
    try {
        const startDate = toDateOnly(new Date());
        await pool.query(
            `INSERT INTO school_settings (setting_key, setting_value, school_id) VALUES ('current_term', ?, ?)
             ON DUPLICATE KEY UPDATE setting_value = ?`,
            [term, req.user.school_id, term]
        );
        await pool.query(
            `INSERT INTO school_settings (setting_key, setting_value, school_id) VALUES ('term_start_date', ?, ?)
             ON DUPLICATE KEY UPDATE setting_value = ?`,
            [startDate, req.user.school_id, startDate]
        );
        // Starting (or switching to) a term always (re)opens it — this is
        // the only way semester_status flips back to 'open' once Academic
        // VP has closed it, e.g. moving on to Semester 2.
        await pool.query(
            `INSERT INTO school_settings (setting_key, setting_value, school_id) VALUES ('semester_status', 'open', ?)
             ON DUPLICATE KEY UPDATE setting_value = 'open'`,
            [req.user.school_id]
        );
        res.json({ message: `${term} started. Attendance counting begins today (${startDate}).`, current_term: term, term_start_date: startDate, semester_status: 'open' });
    } catch (err) {
        console.error("term/set error:", err);
        res.status(500).json({ error: "Could not update current term" });
    }
});

// "Close Semester" — Academic VP marks the currently active term as
// closed (e.g. once every section's marks have been pushed and the term
// is administratively wrapped up). Deliberately doesn't touch
// current_term or term_start_date: the label everyone sees should read
// "Closed · Semester 1", not silently reset to some other term. Re-opens
// via POST /api/term/set (Start Semester) same as above.
app.post('/api/term/close', requireAuth, requireRole('admin_users'), async (req, res) => {
    try {
        const term = await getCurrentTerm(req.user.school_id);
        await pool.query(
            `INSERT INTO school_settings (setting_key, setting_value, school_id) VALUES ('semester_status', 'closed', ?)
             ON DUPLICATE KEY UPDATE setting_value = 'closed'`,
            [req.user.school_id]
        );
        res.json({ message: `${term} closed.`, current_term: term, semester_status: 'closed' });
    } catch (err) {
        console.error("term/close error:", err);
        res.status(500).json({ error: "Could not close semester" });
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

// Human-readable labels for assessment_type, kept in sync with the
// <option> labels in the "Notify Students" dropdown on the frontend.
// Falls back to a title-cased, underscore-stripped version of the raw
// value so an unmapped type still reads reasonably instead of showing
// the raw db value verbatim.
const ASSESSMENT_TYPE_LABELS = {
    individual_assignment_1: 'Individual Assignment 1',
    individual_assignment_2: 'Individual Assignment 2',
    group_assignment: 'Group Assignment',
    quiz: 'Quiz',
    midterm: 'Midterm',
    final: 'Final Exam'
};
function assessmentTypeLabel(type) {
    if (ASSESSMENT_TYPE_LABELS[type]) return ASSESSMENT_TYPE_LABELS[type];
    return String(type).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

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
            message: `Notification sent to ${students.length} student(s) who haven't completed ${assessmentTypeLabel(assessment_type)}.`,
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

        issueAuthToken(res, {
            user_id: id,
            role: userRole,
            school_id: user.school_id || null,
            title: userRole === 'admin_users' ? (user.title || null) : null,
            is_class_monitor: userRole === 'students' ? !!user.is_class_monitor : false
        });

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
        let moe_school_code = null;
        if (req.user.school_id) {
            const [schoolRows] = await pool.query(
                'SELECT school_name, moe_school_code FROM schools WHERE id = ?',
                [req.user.school_id]
            );
            if (schoolRows.length > 0) {
                school_name = schoolRows[0].school_name;
                moe_school_code = schoolRows[0].moe_school_code;
            }
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
            moe_school_code,
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