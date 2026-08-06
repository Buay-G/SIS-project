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
import crypto, { Certificate } from 'crypto';
import sizeOf from 'image-size';
import heicConvert from 'heic-convert';
import puppeteer from 'puppeteer';
// archiver v8 dropped the old `archiver('zip', opts)` factory
// function entirely — it now only exports classes (ZipArchive etc.),
// no default export. Older docs/examples online still show the old
// factory API; ZipArchive is the current one.
import { ZipArchive } from 'archiver';
import { PDFDocument, StandardFonts } from 'pdf-lib';
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
app.use('/school-admin', express.static(path.join(__dirname, 'modules/school admin')));
app.use('/zonal-admin', express.static(path.join(__dirname, 'modules/zonal admin')));
app.use('/super-admin', express.static(path.join(__dirname, 'modules/super admin')));
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

// Monday-Friday only, and not an Ethiopian calendar holiday (see
// isEthiopianHoliday(), defined further down in this file — function
// declarations hoist, and this is never called until a request comes
// in, long after the whole module has finished loading, so the
// forward reference is safe). This is the single choke point every
// absence-inferring feature goes through — countAbsentDays,
// computeStreak (student AND teacher streaks), and the day-status
// generators below — so a holiday now behaves like a school closure
// everywhere absence would otherwise be inferred, not just on
// weekends.
function isSchoolDay(date) {
    const day = date.getDay();
    if (day === 0 || day === 6) return false;
    return !isEthiopianHoliday(date);
}
function toDateOnly(d) {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
const JWT_EXPIRES_IN = '30m'; // short-lived on purpose — see refresh notes below

function issueAuthToken(res, { user_id, role, school_id, zone, zone_id, title, is_class_monitor, can_act_independently }) {
    const token = jwt.sign({ user_id, role, school_id, zone: zone || null, zone_id: zone_id || null, title: title || null, is_class_monitor: !!is_class_monitor, can_act_independently: !!can_act_independently }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
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

// Requires not just a school_admins account, but specifically the one
// whose title = 'Principal'. Set the actual principal's row: title =
// 'Principal'. Without that column populated, every school_admins login
// will fail this check (title comes back null from the token, matching
// no one) — safer to fail closed than to silently let any school admin
// account act as Principal.
function requirePrincipal(req, res, next) {
    if (!req.user || req.user.role !== 'school_admins' || req.user.title !== 'Principal') {
        return res.status(403).json({ error: "This action is restricted to the Principal's account." });
    }
    next();
}

// School-level authority is split three ways within school_admins, by
// title (same pattern as requirePrincipal above, generalized):
//   - Admin VP: teacher attendance, textbook logistics (issue/return/lost
//     + the penalty decision), and teacher absence requests up to 5 days
//     — anything longer is routed straight to the Principal instead of
//     Admin VP even seeing it as approvable (see /api/teacher/absence-requests).
//   - Academic VP: the timetable, opening/closing the semester, reviewing
//     every homeroom's pushed marks (and who hasn't pushed yet), and
//     student conduct — a warning is theirs to give directly, a
//     termination-level case gets handed to the Principal instead.
//   - Principal: sees everything above and is the first to be alerted
//     when something's escalated to them (long absence requests,
//     termination-level conduct cases, document approvals, etc.) —
//     already partly built via requirePrincipal.
function requireAdminTitle(...allowedTitles) {
    return (req, res, next) => {
        if (!req.user || req.user.role !== 'school_admins' || !allowedTitles.includes(req.user.title)) {
            return res.status(403).json({ error: `This action is restricted to: ${allowedTitles.join(', ')}.` });
        }
        next();
    };
}

// --- Registrar & Recorder ---
// Registrar can happen two ways, both fully equivalent to every endpoint
// below (see requireRegistrarOnly/requireRegistrarOrRecorder): (1) a
// standalone `registrar_users` account (created outside this app), or
// (2) a flag — teachers.is_registrar — an Academic VP grants straight
// onto an existing teacher's own login via
// POST /api/academic-vp/grant-registrar, no separate account needed.
// A Recorder is always a regular `teachers` account with is_recorder = 1
// on that same row — same pattern as is_registrar, not a separate join
// table — up to 2 active per school, managed BY the Registrar (whichever
// kind) via /api/registrar/recorders.
//
// ADD THESE if they don't exist yet:
//   ALTER TABLE teachers
//     ADD COLUMN is_registrar TINYINT(1) NOT NULL DEFAULT 0,
//     ADD COLUMN registrar_assigned_by VARCHAR(50) NULL,
//     ADD COLUMN registrar_assigned_at DATETIME NULL,
//     ADD COLUMN is_recorder TINYINT(1) NOT NULL DEFAULT 0,
//     ADD COLUMN recorder_assigned_by VARCHAR(50) NULL,
//     ADD COLUMN recorder_assigned_at DATETIME NULL;
//
//   CREATE TABLE class_sections (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     school_id INT NOT NULL,
//     class_level INT NOT NULL,
//     stream VARCHAR(50) NOT NULL,
//     section_name VARCHAR(5) NOT NULL,
//     max_capacity INT NULL,
//     is_active BOOLEAN NOT NULL DEFAULT TRUE,
//     UNIQUE KEY uniq_section (school_id, class_level, stream, section_name)
//   );
//
//   CREATE TABLE promotion_audit_log (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     student_id VARCHAR(50) NOT NULL,
//     school_id INT NOT NULL,
//     action ENUM('promote','retain') NOT NULL,
//     from_class_level INT NOT NULL,
//     to_class_level INT NULL,
//     year_average DECIMAL(5,2) NULL,
//     cutoff_mark DECIMAL(5,2) NULL,
//     was_override BOOLEAN NOT NULL DEFAULT FALSE,
//     override_reason TEXT NULL,
//     decided_by VARCHAR(50) NOT NULL,
//     decided_at DATETIME DEFAULT CURRENT_TIMESTAMP
//   );
//
//   -- New registrations now sit unassigned until the Placement Wizard
//   -- runs, so `section` must accept NULL:
//   ALTER TABLE students MODIFY section VARCHAR(5) NULL;

// Registration + routine profile updates are shared ground between the
// Registrar and any assigned Recorder. Everything else (section setup,
// placement, promotion, recorder management) stays Registrar-only via
// requireRegistrarOnly below.
async function requireRegistrarOrRecorder(req, res, next) {
    if (!req.user) return res.status(401).json({ error: "Not logged in." });
    if (req.user.role === 'registrar_users') return next();
    if (req.user.role === 'teachers') {
        try {
            const [teacherRows] = await pool.query(
                'SELECT is_registrar, is_recorder FROM teachers WHERE teacher_id = ? AND school_id = ?',
                [req.user.user_id, req.user.school_id]
            );
            if (teacherRows.length > 0 && (!!teacherRows[0].is_registrar || !!teacherRows[0].is_recorder)) return next();
        } catch (err) {
            console.error("requireRegistrarOrRecorder lookup failed:", err);
            return res.status(500).json({ error: "Could not verify permissions." });
        }
    }
    return res.status(403).json({ error: "You don't have permission to do this." });
}

// A Registrar isn't only a standalone registrar_users account anymore —
// it's also just a flag (teachers.is_registrar) an Academic VP can grant
// straight onto an existing teacher's own login (see
// POST /api/academic-vp/grant-registrar). Both paths land here.
async function requireRegistrarOnly(req, res, next) {
    if (!req.user) return res.status(403).json({ error: "This action is restricted to the Registrar." });
    if (req.user.role === 'registrar_users') return next();
    if (req.user.role === 'teachers') {
        try {
            const [rows] = await pool.query('SELECT is_registrar FROM teachers WHERE teacher_id = ? AND school_id = ?', [req.user.user_id, req.user.school_id]);
            if (rows.length > 0 && !!rows[0].is_registrar) return next();
        } catch (err) {
            console.error("requireRegistrarOnly lookup failed:", err);
            return res.status(500).json({ error: "Could not verify permissions." });
        }
    }
    return res.status(403).json({ error: "This action is restricted to the Registrar." });
}

// --- Zonal admin & super admin ---
// A "zone" isn't one flat admin role — it's three distinct positions,
// all in the existing zonal_admins table (distinguished by `title`, same
// pattern as school_admins.title), with three different scopes:
//   - Head of Education: whole zone, full authority — hires teachers,
//     appoints school admins, sees every school's performance.
//   - Teacher Development Coordinator: whole zone for VIEWING, but no independent
//     authority — can only write a proposal (hire/appoint), which Head
//     of Education must approve before anything actually happens.
//     Head of Education can delegate direct authority to a specific
//     Development Coordinator (can_act_independently), which lets them skip the
//     proposal step and act like Head of Education until revoked.
//   - Supervisor: NOT whole-zone — scoped to a specific, individually
//     assigned set of schools (e.g. 2 schools), view-only. They check
//     teacher/school performance (attendance, whether marks are being
//     uploaded on the usual ~2-week cadence) and follow up directly with
//     the school admin or teacher; they have no account-creation power
//     at all, not even for their own assigned schools.
//
// zonal_admins and super_admins already exist and can already log in
// (see the authSources list in /api/login) — this just adds the columns
// and tables the actual zonal/super-admin FEATURES need. ADD THESE if
// they don't exist yet:
//   CREATE TABLE zones (
//     zone_id INT AUTO_INCREMENT PRIMARY KEY,
//     zone_name VARCHAR(100) NOT NULL,
//     zone_prefix VARCHAR(10) NOT NULL UNIQUE, -- e.g. 'GM'
//     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
//   );
//   ALTER TABLE schools ADD COLUMN zone_id INT NULL,
//     ADD FOREIGN KEY (zone_id) REFERENCES zones(zone_id);
//   -- backfill zone_id for existing rows from the old free-text
//   -- schools.zone column once the matching zones rows exist; the old
//   -- zone column can stay for display/history (the certificate and ID
//   -- card templates already read it), zone_id is what scoping actually
//   -- uses going forward.
//
//   ALTER TABLE zonal_admins
//     ADD COLUMN zone_id INT NULL,
//     ADD COLUMN title ENUM('Head of Education','Teacher Development Coordinator','Supervisor') NULL,
//     ADD COLUMN can_act_independently BOOLEAN NOT NULL DEFAULT FALSE, -- only meaningful for Teacher Development Coordinator; set/unset by Head of Education
//     ADD FOREIGN KEY (zone_id) REFERENCES zones(zone_id);
//
//   -- Which specific schools a Supervisor is assigned to (Head of
//   -- Education and Teacher Development Coordinator don't need rows here — their
//   -- scope is derived directly from zone_id instead).
//   CREATE TABLE zone_admin_schools (
//     admin_id VARCHAR(20) NOT NULL, -- zonal_admins.admin_id
//     school_id INT NOT NULL,
//     PRIMARY KEY (admin_id, school_id),
//     FOREIGN KEY (admin_id) REFERENCES zonal_admins(admin_id),
//     FOREIGN KEY (school_id) REFERENCES schools(id)
//   );
//
//   -- A Teacher Development Coordinator's "write a proposal, Head of Education
//   -- approves" workflow for hiring a teacher or appointing a school
//   -- admin. `payload` carries whatever /api/zonal/admin-users or
//   -- /api/zonal/teachers needs to actually create the account once
//   -- approved — same shape as that endpoint's body.
//   CREATE TABLE zonal_proposals (
//     proposal_id INT AUTO_INCREMENT PRIMARY KEY,
//     zone_id INT NOT NULL,
//     proposed_by VARCHAR(20) NOT NULL, -- zonal_admins.admin_id
//     proposal_type ENUM('hire_teacher','appoint_school_admin') NOT NULL,
//     school_id INT NOT NULL,
//     payload JSON NOT NULL,
//     status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
//     rejection_reason VARCHAR(255) NULL,
//     reviewed_by VARCHAR(20) NULL,
//     reviewed_at DATETIME NULL,
//     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     FOREIGN KEY (zone_id) REFERENCES zones(zone_id)
//   );
//
//   -- The zone's curriculum subject list — the Head of Education sets
//   -- which subjects exist for their zone (e.g. Nuer/Dha-Anywaa mother-
//   -- tongue subjects only make sense in the zones that teach them); an
//   -- Academic VP at a school in that zone can then only pick a subject
//   -- for their own school's Subject Configuration from THIS list (see
//   -- /api/academic-vp/subject-dictionary below), never free text. This
//   -- replaces the old hardcoded SUBJECT_CATALOG array — that array is
//   -- gone; the dictionary is now the single source of truth, per zone.
//   CREATE TABLE subject_dictionary (
//     subject_dict_id INT AUTO_INCREMENT PRIMARY KEY,
//     zone_id INT NOT NULL,
//     subject_name VARCHAR(100) NOT NULL,
//     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     UNIQUE KEY zone_subject (zone_id, subject_name),
//     FOREIGN KEY (zone_id) REFERENCES zones(zone_id)
//   );
//
// Super admin (super_admins, already live for login) stays manually
// seeded, no auto-ID generation, no school_id/zone_id scoping — every
// school_id-scoped query in this file needs its own super-admin bypass
// to actually be usable by them; that's a broader follow-up, not part
// of this block.
function requireZonalAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'zonal_admins') {
        return res.status(403).json({ error: "This action is restricted to zonal admin accounts." });
    }
    next();
}
function requireSuperAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'super_admins') {
        return res.status(403).json({ error: "This action is restricted to super admin accounts." });
    }
    next();
}
// Only the Head of Education — hiring/appointing/delegating are theirs
// alone to do directly; everyone else in the zone works through them.
function requireHeadOfEducation(req, res, next) {
    if (!req.user || req.user.role !== 'zonal_admins' || req.user.title !== 'Head of Education') {
        return res.status(403).json({ error: "This action is restricted to the Head of Education." });
    }
    next();
}
// Head of Education always has direct authority; a Teacher Development Coordinator
// only has it if Head of Education has delegated it
// (can_act_independently); Supervisors never do, regardless of this
// flag — the check on req.user.title !== 'Supervisor' isn't really
// needed since Supervisors never get can_act_independently set, but
// it's here so a bad seed value can't accidentally grant one supervisor
// hiring power.
function requireCanActInZone(req, res, next) {
    if (!req.user || req.user.role !== 'zonal_admins') {
        return res.status(403).json({ error: "This action is restricted to zonal admin accounts." });
    }
    if (req.user.title === 'Head of Education') return next();
    if (req.user.title === 'Teacher Development Coordinator' && req.user.can_act_independently) return next();
    return res.status(403).json({
        error: req.user.title === 'Teacher Development Coordinator'
            ? "You don't have delegated authority to do this directly — submit a proposal instead."
            : "This action is restricted to the Head of Education."
    });
}

// Returns the school IDs this zonal_admins account can see/act on:
// Head of Education & Teacher Development Coordinator → every school in their zone;
// Supervisor → only their individually assigned schools
// (zone_admin_schools). Used to scope every zonal read/write so a
// Supervisor calling a shared endpoint can never see beyond their own
// assignment.
async function getZonalSchoolIds(req) {
    if (req.user.title === 'Supervisor') {
        const [rows] = await pool.query(
            'SELECT school_id FROM zone_admin_schools WHERE admin_id = ?',
            [req.user.user_id]
        );
        return rows.map(r => r.school_id);
    }
    const [rows] = await pool.query('SELECT id FROM schools WHERE zone_id = ?', [req.user.zone_id]);
    return rows.map(r => r.id);
}

// Generates the next ID for a given prefix at a given school, drawing
// from ONE shared sequence across teachers AND school_admins. That's
// what lets a school admin account carry the same TCH-style ID/prefix a
// teacher would: whichever table actually holds "TCH0007" for this
// school, the number is only ever handed out once, so the two tables
// never collide on the same ID even though neither one has its own
// dedicated counter.
async function getNextStaffId(school_id, prefix, digits = 5) {
    const [[teacherRows], [adminRows]] = await Promise.all([
        pool.query('SELECT teacher_id AS id FROM teachers WHERE school_id = ? AND teacher_id LIKE ?', [school_id, `${prefix}%`]),
        pool.query('SELECT admin_id AS id FROM school_admins WHERE school_id = ? AND admin_id LIKE ?', [school_id, `${prefix}%`])
    ]);
    const allIds = [...teacherRows, ...adminRows].map(r => r.id);
    let maxNumber = 0;
    for (const id of allIds) {
        const numPart = parseInt(id.slice(prefix.length), 10);
        if (!isNaN(numPart) && numPart > maxNumber) maxNumber = numPart;
    }
    return `${prefix}${String(maxNumber + 1).padStart(digits, '0')}`;
}

// --- Zonal: schools & school admin accounts ---
// GET is available to all three zonal_admins titles, scoped by
// getZonalSchoolIds — Head of Education/Teacher Development Coordinator see every
// school in the zone, Supervisors see only their assigned schools.
app.get('/api/zonal/schools', requireAuth, requireZonalAdmin, async (req, res) => {
    try {
        const schoolIds = await getZonalSchoolIds(req);
        if (schoolIds.length === 0) return res.json([]);
        const [schools] = await pool.query(
            `SELECT sc.id, sc.school_name, sc.school_prefix, sc.moe_school_code,
                    w.woreda_name AS woreda, r.region_name AS region
             FROM schools sc
             LEFT JOIN woreda w ON w.woreda_id = sc.woreda_id
             LEFT JOIN region r ON r.region_id = sc.region_id
             WHERE sc.id IN (?) ORDER BY sc.school_name`,
            [schoolIds]
        );
        res.json(schools);
    } catch (err) {
        console.error("/api/zonal/schools error:", err);
        res.status(500).json({ error: "Could not load your schools" });
    }
});

// --- Zonal: subject dictionary ---
// The zone's curriculum subject list. GET is available to all three
// zonal_admins titles (view-only for Teacher Development Coordinator/Supervisor,
// same as /api/zonal/schools) — Supervisors aren't scoped to specific
// schools here since the dictionary belongs to the whole zone, not to
// any one school. Adding/removing subjects is a zone-wide curriculum
// decision, so it's restricted the same way hiring/appointing is:
// Head of Education, or a Teacher Development Coordinator with delegated authority.
app.get('/api/zonal/subject-dictionary', requireAuth, requireZonalAdmin, async (req, res) => {
    try {
        const [subjects] = await pool.query(
            'SELECT subject_dict_id, subject_name FROM subject_dictionary WHERE zone_id = ? ORDER BY subject_name',
            [req.user.zone_id]
        );
        res.json(subjects);
    } catch (err) {
        console.error("/api/zonal/subject-dictionary GET error:", err);
        res.status(500).json({ error: "Could not load the subject dictionary" });
    }
});

app.post('/api/zonal/subject-dictionary', requireAuth, requireCanActInZone, async (req, res) => {
    const { subject_name } = req.body;
    if (!subject_name || !subject_name.trim()) return res.status(400).json({ error: "subject_name is required" });
    try {
        const [existing] = await pool.query(
            'SELECT subject_dict_id FROM subject_dictionary WHERE zone_id = ? AND subject_name = ?',
            [req.user.zone_id, subject_name.trim()]
        );
        if (existing.length > 0) return res.status(409).json({ error: "This subject is already in the dictionary." });

        const [insertResult] = await pool.query(
            'INSERT INTO subject_dictionary (zone_id, subject_name) VALUES (?, ?)',
            [req.user.zone_id, subject_name.trim()]
        );
        res.json({ message: "Subject added to dictionary.", subject_dict_id: insertResult.insertId });
    } catch (err) {
        console.error("/api/zonal/subject-dictionary POST error:", err);
        res.status(500).json({ error: "Could not add subject" });
    }
});

// Removing a dictionary entry doesn't touch any school's already-saved
// Subject Configuration rows (subjects.subject_name is a plain string,
// not a foreign key to subject_dictionary) — it only stops that name
// from being offered to Academic VPs going forward. That's deliberate:
// a school that's already teaching a subject shouldn't lose its
// existing configuration just because the zone stops listing it, e.g.
// while the zone is transitioning a subject out.
app.delete('/api/zonal/subject-dictionary/:subject_dict_id', requireAuth, requireCanActInZone, async (req, res) => {
    try {
        const [result] = await pool.query(
            'DELETE FROM subject_dictionary WHERE subject_dict_id = ? AND zone_id = ?',
            [req.params.subject_dict_id, req.user.zone_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Subject not found in your zone's dictionary." });
        res.json({ message: "Subject removed from dictionary." });
    } catch (err) {
        console.error("/api/zonal/subject-dictionary DELETE error:", err);
        res.status(500).json({ error: "Could not remove subject" });
    }
});

// Creates a school admin (Principal, Admin VP, Academic VP, etc.) account
// directly. Restricted to Head of Education, or a Teacher Development Coordinator
// Head of Education has delegated direct authority to — everyone else
// (including a non-delegated Development Coordinator) has to go through
// /api/zonal/proposals instead. The new account's ID shares the school's
// TCH-style staff sequence with its teachers (see getNextStaffId) — it's
// not a separate identity space, just a different table for a different
// set of privileges.
async function createSchoolAdminAccount({ school_id, first_name, middle_name, last_name, title, contact_number, email, password }) {
    const [schoolRows] = await pool.query('SELECT id, school_prefix FROM schools WHERE id = ?', [school_id]);
    if (schoolRows.length === 0) throw Object.assign(new Error("School not found."), { status: 404 });
    const { school_prefix } = schoolRows[0];
    if (!school_prefix) throw Object.assign(new Error("This school has no ID prefix configured yet."), { status: 400 });

    const admin_id = await getNextStaffId(school_id, school_prefix);
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
        `INSERT INTO school_admins (admin_id, school_id, first_name, middle_name, last_name, title, contact_number, email, security_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [admin_id, school_id, first_name, middle_name || null, last_name, title, contact_number || null, email || null, hashedPassword]
    );
    return admin_id;
}

app.post('/api/zonal/admin-users', requireAuth, requireCanActInZone, async (req, res) => {
    const { school_id, first_name, middle_name, last_name, title, contact_number, email, password } = req.body;
    if (!school_id || !first_name || !last_name || !title || !password) {
        return res.status(400).json({ error: "school_id, first_name, last_name, title, and password are required" });
    }
    try {
        const zoneSchoolIds = await getZonalSchoolIds(req);
        if (!zoneSchoolIds.includes(Number(school_id))) {
            return res.status(403).json({ error: "That school isn't in your zone." });
        }
        const admin_id = await createSchoolAdminAccount({ school_id, first_name, middle_name, last_name, title, contact_number, email, password });
        res.json({ message: "School admin account created.", admin_id });
    } catch (err) {
        console.error("/api/zonal/admin-users error:", err);
        res.status(err.status || 500).json({ error: err.status ? err.message : "Could not create school admin account" });
    }
});

app.get('/api/zonal/admin-users', requireAuth, requireZonalAdmin, async (req, res) => {
    try {
        const schoolIds = await getZonalSchoolIds(req);
        if (schoolIds.length === 0) return res.json([]);
        const [rows] = await pool.query(
            `SELECT a.admin_id, a.first_name, a.middle_name, a.last_name, a.title, a.school_id, s.school_name
             FROM school_admins a
             JOIN schools s ON s.id = a.school_id
             WHERE a.school_id IN (?)
             ORDER BY s.school_name, a.title`,
            [schoolIds]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/zonal/admin-users GET error:", err);
        res.status(500).json({ error: "Could not load school admin accounts" });
    }
});

// Hires a teacher directly — same authority restriction as appointing a
// school admin (Head of Education, or a delegated Teacher Development Coordinator).
async function createTeacherAccount({ school_id, first_name, middle_name, last_name, contact_number, email, password }) {
    const [schoolRows] = await pool.query('SELECT id, school_prefix FROM schools WHERE id = ?', [school_id]);
    if (schoolRows.length === 0) throw Object.assign(new Error("School not found."), { status: 404 });
    const { school_prefix } = schoolRows[0];
    if (!school_prefix) throw Object.assign(new Error("This school has no ID prefix configured yet."), { status: 400 });

    const teacher_id = await getNextStaffId(school_id, school_prefix);
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
        `INSERT INTO teachers (teacher_id, school_id, first_name, middle_name, last_name, contact_number, email, security_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [teacher_id, school_id, first_name, middle_name || null, last_name, contact_number || null, email || null, hashedPassword]
    );
    return teacher_id;
}

// --- Teacher intake: Zonal push -> Principal accept -> Academic VP assign ---
// A zonal admin no longer mints a live, loggable-in teacher account
// directly at the school (that used to happen right here). Instead they
// PUSH a candidate to a specific school; the account isn't real until
// that school's Principal reviews it and accepts it (Stage 1 of the
// Teacher Setup & Assignment workflow — see the EXECUTIVE SCHOOL
// ADMINISTRATION SUITE block further down for the Principal-side
// endpoints and Stage 2's Academic VP handoff). This is also why the
// hire_teacher branch of /api/zonal/proposals/:id/approve below now
// pushes instead of creating directly — a Head of Education approving a
// Development Coordinator's hire proposal still isn't the school-level gate; the
// Principal is.
//
// ADD THIS if it doesn't exist yet:
//   CREATE TABLE incoming_teachers (
//     incoming_id INT AUTO_INCREMENT PRIMARY KEY,
//     school_id INT NOT NULL,
//     pushed_by VARCHAR(20) NOT NULL, -- zonal_admins.admin_id (provenance for a proposal-approved push is in the linked zonal_proposals row)
//     first_name VARCHAR(100) NOT NULL,
//     middle_name VARCHAR(100) NULL,
//     last_name VARCHAR(100) NOT NULL,
//     contact_number VARCHAR(30) NULL,
//     email VARCHAR(150) NULL,
//     zonal_recruitment_code VARCHAR(50) NULL,
//     status ENUM('pending','accepted','declined') NOT NULL DEFAULT 'pending',
//     teacher_id VARCHAR(50) NULL, -- filled in once the Principal accepts and mints the real ID
//     decided_by VARCHAR(50) NULL, -- school_admins.admin_id (the Principal) who accepted/declined
//     decided_at DATETIME NULL,
//     decline_reason VARCHAR(255) NULL,
//     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     FOREIGN KEY (school_id) REFERENCES schools(id)
//   );
async function pushIncomingTeacher({ school_id, pushed_by, first_name, middle_name, last_name, contact_number, email, zonal_recruitment_code }) {
    const [schoolRows] = await pool.query('SELECT id FROM schools WHERE id = ?', [school_id]);
    if (schoolRows.length === 0) throw Object.assign(new Error("School not found."), { status: 404 });
    const [result] = await pool.query(
        `INSERT INTO incoming_teachers (school_id, pushed_by, first_name, middle_name, last_name, contact_number, email, zonal_recruitment_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [school_id, pushed_by, first_name, middle_name || null, last_name, contact_number || null, email || null, zonal_recruitment_code || null]
    );
    return result.insertId;
}

app.post('/api/zonal/teachers', requireAuth, requireCanActInZone, async (req, res) => {
    const { school_id, first_name, middle_name, last_name, contact_number, email, zonal_recruitment_code } = req.body;
    if (!school_id || !first_name || !last_name) {
        return res.status(400).json({ error: "school_id, first_name, and last_name are required" });
    }
    try {
        const zoneSchoolIds = await getZonalSchoolIds(req);
        if (!zoneSchoolIds.includes(Number(school_id))) {
            return res.status(403).json({ error: "That school isn't in your zone." });
        }
        const incoming_id = await pushIncomingTeacher({
            school_id, pushed_by: req.user.user_id, first_name, middle_name, last_name, contact_number, email, zonal_recruitment_code
        });
        res.json({ message: "Teacher pushed to the school. Their Principal will review and accept before the account goes live.", incoming_id });
    } catch (err) {
        console.error("/api/zonal/teachers error:", err);
        res.status(err.status || 500).json({ error: err.status ? err.message : "Could not push teacher to school" });
    }
});

// Lets the pushing zonal admin track what happened to what they sent
// (still pending / accepted with a real teacher_id / declined with a
// reason) without needing school-level access.
app.get('/api/zonal/incoming-teachers', requireAuth, requireZonalAdmin, async (req, res) => {
    try {
        const schoolIds = await getZonalSchoolIds(req);
        if (schoolIds.length === 0) return res.json([]);
        const [rows] = await pool.query(
            `SELECT it.incoming_id, it.school_id, s.school_name, it.first_name, it.middle_name, it.last_name,
                    it.status, it.teacher_id, it.decline_reason, it.created_at, it.decided_at
             FROM incoming_teachers it
             JOIN schools s ON s.id = it.school_id
             WHERE it.school_id IN (?) AND it.pushed_by = ?
             ORDER BY it.created_at DESC`,
            [schoolIds, req.user.user_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/zonal/incoming-teachers error:", err);
        res.status(500).json({ error: "Could not load pushed teachers" });
    }
});

// --- Zonal: Teacher Development Coordinator proposals (hire / appoint), reviewed by Head of Education ---
// A non-delegated Development Coordinator can't call /api/zonal/admin-users or
// /api/zonal/teachers directly (requireCanActInZone blocks them) — this
// is their path instead: describe what they want done, Head of
// Education approves or rejects it.
app.post('/api/zonal/proposals', requireAuth, requireZonalAdmin, async (req, res) => {
    if (req.user.title !== 'Teacher Development Coordinator') {
        return res.status(403).json({ error: "Only the Teacher Development Coordinator submits proposals — Head of Education acts directly, and Supervisors don't have hiring/appointing authority at all." });
    }
    const { proposal_type, school_id, payload } = req.body;
    if (!proposal_type || !school_id || !payload) {
        return res.status(400).json({ error: "proposal_type, school_id, and payload are required" });
    }
    if (!['hire_teacher', 'appoint_school_admin'].includes(proposal_type)) {
        return res.status(400).json({ error: "proposal_type must be 'hire_teacher' or 'appoint_school_admin'" });
    }
    try {
        const zoneSchoolIds = await getZonalSchoolIds(req);
        if (!zoneSchoolIds.includes(Number(school_id))) {
            return res.status(403).json({ error: "That school isn't in your zone." });
        }
        await pool.query(
            `INSERT INTO zonal_proposals (zone_id, proposed_by, proposal_type, school_id, payload)
             VALUES (?, ?, ?, ?, ?)`,
            [req.user.zone_id, req.user.user_id, proposal_type, school_id, JSON.stringify(payload)]
        );
        res.json({ message: "Proposal submitted for Head of Education's review." });
    } catch (err) {
        console.error("/api/zonal/proposals POST error:", err);
        res.status(500).json({ error: "Could not submit proposal" });
    }
});

// Head of Education sees every pending proposal in the zone; a
// Development Coordinator sees only their own (so they can track what they've sent).
app.get('/api/zonal/proposals', requireAuth, requireZonalAdmin, async (req, res) => {
    try {
        const params = [req.user.zone_id];
        let whereClause = 'WHERE zone_id = ?';
        if (req.user.title !== 'Head of Education') {
            whereClause += ' AND proposed_by = ?';
            params.push(req.user.user_id);
        }
        const [rows] = await pool.query(
            `SELECT proposal_id, proposed_by, proposal_type, school_id, payload, status, rejection_reason, reviewed_by, reviewed_at, created_at
             FROM zonal_proposals ${whereClause} ORDER BY created_at DESC`,
            params
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/zonal/proposals GET error:", err);
        res.status(500).json({ error: "Could not load proposals" });
    }
});

app.post('/api/zonal/proposals/:id/approve', requireAuth, requireHeadOfEducation, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT * FROM zonal_proposals WHERE proposal_id = ? AND zone_id = ? AND status = 'pending'`,
            [req.params.id, req.user.zone_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Proposal not found or already reviewed." });
        const proposal = rows[0];
        const payload = typeof proposal.payload === 'string' ? JSON.parse(proposal.payload) : proposal.payload;

        let resultId, message;
        if (proposal.proposal_type === 'hire_teacher') {
            // Approval doesn't create a live teacher account anymore — it
            // pushes the candidate to the school, same as a direct hire via
            // /api/zonal/teachers. The Principal still has to accept it.
            resultId = await pushIncomingTeacher({ school_id: proposal.school_id, pushed_by: proposal.proposed_by, ...payload });
            message = "Proposal approved and pushed to the school. Their Principal will review and accept before the account goes live.";
        } else {
            resultId = await createSchoolAdminAccount({ school_id: proposal.school_id, ...payload });
            message = "Proposal approved and account created.";
        }

        await pool.query(
            `UPDATE zonal_proposals SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE proposal_id = ?`,
            [req.user.user_id, proposal.proposal_id]
        );
        res.json({ message, id: resultId });
    } catch (err) {
        console.error("/api/zonal/proposals/:id/approve error:", err);
        res.status(err.status || 500).json({ error: err.status ? err.message : "Could not approve proposal" });
    }
});

app.post('/api/zonal/proposals/:id/reject', requireAuth, requireHeadOfEducation, async (req, res) => {
    const { reason } = req.body;
    try {
        const [result] = await pool.query(
            `UPDATE zonal_proposals SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW()
             WHERE proposal_id = ? AND zone_id = ? AND status = 'pending'`,
            [reason || null, req.user.user_id, req.params.id, req.user.zone_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Proposal not found or already reviewed." });
        res.json({ message: "Proposal rejected." });
    } catch (err) {
        console.error("/api/zonal/proposals/:id/reject error:", err);
        res.status(500).json({ error: "Could not reject proposal" });
    }
});

// Head of Education grants/revokes a Teacher Development Coordinator's ability to act
// directly (skip the proposal step). Scoped to Development Coordinators in their own
// zone only.
app.post('/api/zonal/teamleader/:id/delegate', requireAuth, requireHeadOfEducation, async (req, res) => {
    const { can_act_independently } = req.body;
    try {
        const [result] = await pool.query(
            `UPDATE zonal_admins SET can_act_independently = ?
             WHERE admin_id = ? AND zone_id = ? AND title = 'Teacher Development Coordinator'`,
            [!!can_act_independently, req.params.id, req.user.zone_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Teacher Development Coordinator not found in your zone." });
        res.json({ message: can_act_independently ? "Direct authority delegated." : "Direct authority revoked." });
    } catch (err) {
        console.error("/api/zonal/teamleader/:id/delegate error:", err);
        res.status(500).json({ error: "Could not update delegation" });
    }
});

// --- Zonal: Supervisor performance view ---
// Read-only, scoped to the Supervisor's individually assigned schools
// (or, for Head of Education/Development Coordinator, every school in the zone).
// Flags two things per teacher: recent absence (period_attendance_log,
// same source as /api/admin/teacher-punctuality) and whether marks have
// been uploaded in roughly the last 2 weeks (marks.uploaded_at) — the
// two signals a Supervisor actually follows up on in person.
//
// Requires a timestamp on marks to compute the second signal — ADD IT
// if it doesn't exist yet:
//   ALTER TABLE marks ADD COLUMN uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP;
app.get('/api/zonal/performance', requireAuth, requireZonalAdmin, async (req, res) => {
    try {
        const schoolIds = await getZonalSchoolIds(req);
        if (schoolIds.length === 0) return res.json([]);

        const since = toDateOnly(new Date(Date.now() - 14 * 86400000));

        const [teachers] = await pool.query(
            `SELECT teacher_id, school_id, first_name, last_name FROM teachers WHERE school_id IN (?)`,
            [schoolIds]
        );

        const [attendance] = await pool.query(
            `SELECT ct.teacher_id, pal.teacher_present
             FROM period_attendance_log pal
             JOIN class_timetable ct ON ct.timetable_id = pal.timetable_id
             WHERE pal.school_id IN (?) AND pal.log_date >= ?`,
            [schoolIds, since]
        );
        const [lastMarks] = await pool.query(
            `SELECT ta.teacher_id, MAX(m.uploaded_at) AS last_uploaded
             FROM marks m
             JOIN students st ON st.student_id = m.student_id AND st.school_id = m.school_id
             JOIN teacher_assignments ta ON ta.subject_id = m.subject_id AND ta.school_id = m.school_id
                 AND ta.class_level = st.class_level AND ta.section = st.section AND ta.stream = st.stream
             WHERE m.school_id IN (?)
             GROUP BY ta.teacher_id`,
            [schoolIds]
        ).catch(() => [[]]); // degrade gracefully rather than 500 the whole report if marks.uploaded_at hasn't been added yet

        const attendanceByTeacher = {};
        for (const row of attendance) {
            if (!attendanceByTeacher[row.teacher_id]) attendanceByTeacher[row.teacher_id] = { present: 0, total: 0 };
            attendanceByTeacher[row.teacher_id].total++;
            if (row.teacher_present) attendanceByTeacher[row.teacher_id].present++;
        }
        const lastMarksByTeacher = {};
        for (const row of lastMarks) lastMarksByTeacher[row.teacher_id] = row.last_uploaded;

        const report = teachers.map(t => {
            const att = attendanceByTeacher[t.teacher_id] || { present: 0, total: 0 };
            const lastUpload = lastMarksByTeacher[t.teacher_id] || null;
            const daysSinceUpload = lastUpload ? Math.floor((Date.now() - new Date(lastUpload).getTime()) / 86400000) : null;
            return {
                teacher_id: t.teacher_id,
                full_name: `${t.first_name} ${t.last_name}`,
                school_id: t.school_id,
                periods_logged_last_14_days: att.total,
                periods_present_last_14_days: att.present,
                last_marks_upload: lastUpload,
                days_since_marks_upload: daysSinceUpload,
                needs_followup: att.total > 0 && (att.present / att.total) < 0.8 || daysSinceUpload === null || daysSinceUpload > 14
            };
        });

        res.json(report);
    } catch (err) {
        console.error("/api/zonal/performance error:", err);
        res.status(500).json({ error: "Could not load performance report" });
    }
});

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

// Max (and min) a teacher may enter for each assessment type — these are
// the fixed weights the report card's total_score already assumes it can
// just SUM() (see /api/teacher/push-report): 5 + 5 + 10 + 10 + 30 + 40 =
// 100. A teacher entering, say, 32 for a midterm (weight 30) would push
// that student's total_score over 100 and silently break every average/
// rank calculation downstream, so this is enforced server-side in both
// /api/add-mark and /api/upload-marks, not just left to frontend inputs.
// min: 1 (not 0) per the school's requirement — a genuinely missed
// assessment isn't expected to be recorded as a 0 through this form.
const ASSESSMENT_TYPE_LIMITS = {
    individual_assignment_1: { min: 1, max: 5 },
    individual_assignment_2: { min: 1, max: 5 },
    group_assignment: { min: 1, max: 10 },
    quiz: { min: 1, max: 10 },
    midterm: { min: 1, max: 30 },
    final: { min: 1, max: 40 }
};

// The fixed list of terms the school uses. Admin can only ever switch
// between these — not free text — to keep marks.term consistent.
const TERMS = ['Semester 1', 'Semester 2'];

// subject_dictionary now owns this list (per zone, set by the Head of
// Education — see the schema comment above and the /api/zonal/subject-
// dictionary and /api/academic-vp/subject-dictionary endpoints below).
// There's no code-level catalog to keep in sync anymore. To seed an
// existing zone with the subjects this file used to hardcode, once:
//   INSERT INTO subject_dictionary (zone_id, subject_name) VALUES
//     (<zone_id>,'Nuer'), (<zone_id>,'Mathematics'), (<zone_id>,'English'),
//     (<zone_id>,'Federal Language'), (<zone_id>,'Physics'), (<zone_id>,'Chemistry'),
//     (<zone_id>,'Biology'), (<zone_id>,'Economics'), (<zone_id>,'Geography'),
//     (<zone_id>,'History'), (<zone_id>,'Citizenship'), (<zone_id>,'Agriculture'),
//     (<zone_id>,'IT'), (<zone_id>,'HPE'), (<zone_id>,'Dha-Anywaa');

// Looks up the zone_id a given school belongs to, since Academic VP's
// subject_dictionary reads/validation are scoped by the SCHOOL's zone,
// not by any zonal_admins session (Academic VP isn't a zonal_admins
// account at all).
async function getSchoolZoneId(school_id) {
    const [[school]] = await pool.query('SELECT zone_id FROM schools WHERE id = ?', [school_id]);
    return school ? school.zone_id : null;
}

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

// Whether this teacher is allowed to enter marks for this exact
// subject+class_level+section+stream: either (a) they're formally assigned
// to teach it (teacher_assignments), or (b) a homeroom teacher who was
// specifically granted temporary access by an Academic VP via the
// subject_entry_requests workflow below (e.g. covering for an absent
// colleague). Neither /api/add-mark nor /api/upload-marks checked subject
// ownership at all before this — any authenticated teacher could enter
// marks for any subject in their school, the frontend just never offered
// subjects outside teacher_assignments in its dropdowns. This closes that
// gap and is also what makes "request access to another subject" actually
// mean something rather than being purely cosmetic.
async function hasSubjectAccess(teacher_id, school_id, subject_id, class_level, section, stream) {
    const [assigned] = await pool.query(
        `SELECT 1 FROM teacher_assignments
         WHERE teacher_id = ? AND school_id = ? AND subject_id = ? AND class_level = ? AND section = ? AND stream = ?`,
        [teacher_id, school_id, subject_id, class_level, section, stream]
    );
    if (assigned.length > 0) return true;

    const [approved] = await pool.query(
        `SELECT 1 FROM subject_entry_requests
         WHERE teacher_id = ? AND school_id = ? AND subject_id = ? AND class_level = ? AND section = ? AND stream = ? AND status = 'approved'`,
        [teacher_id, school_id, subject_id, class_level, section, stream]
    );
    return approved.length > 0;
}

// --- API Endpoints ---

app.post('/api/register', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
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

        // No section assigned at registration time anymore — the student
        // sits in the unassigned queue (section IS NULL) until a Registrar
        // runs the Placement Wizard for this grade/stream. See
        // GET/POST /api/registrar/unassigned-queue and /trigger-placement.
        const sql = `INSERT INTO students (student_id, school_id, school_name, first_name, middle_name, last_name, sex, class_level, stream, section, phone_number, fayda_number, status, lms_username, email_address, assigned_computer, security_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`;
        await conn.query(sql, [student_id, school_id, school_name, first_name, middle_name, last_name, sex, class_level, stream, phone_number, fayda_number, status, lms_username, email_address, assigned_pc, security_password]);

        await conn.commit();

        res.json({ message: "Registered!", student_id, assigned_pc, security_password: plain_password });
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

    const limits = ASSESSMENT_TYPE_LIMITS[type];
    const numericScore = Number(score);
    if (score === undefined || score === null || score === '' || isNaN(numericScore) || numericScore < limits.min || numericScore > limits.max) {
        return res.status(400).json({
            error: `${assessmentTypeLabel(type)} must be a score between ${limits.min} and ${limits.max}.`
        });
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

        const allowed = await hasSubjectAccess(req.user.user_id, req.user.school_id, subject_id, class_level, section, stream);
        if (!allowed) {
            return res.status(403).json({
                error: "You are not assigned to teach this subject for this section. If you need to cover for another teacher, ask your homeroom page to request access from the Academic VP."
            });
        }

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
        fs.unlink(file.path, () => { }); // remove the original HEIC now that we have the JPEG
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
                    z.zone_name AS zone, w.woreda_name AS woreda, r.region_name AS region, sc.moe_school_code, sc.school_prefix, sc.logo_url
             FROM students st
             LEFT JOIN schools sc ON sc.id = st.school_id
             LEFT JOIN zone z ON z.zone_id = sc.zone_id
             LEFT JOIN woreda w ON w.woreda_id = sc.woreda_id
             LEFT JOIN region r ON r.region_id = sc.region_id
             WHERE st.student_id = ? AND st.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Student record not found" });
        const profile = rows[0];
        profile.qr_payload = signQrPayload(profile.student_id);

        // The student ID card needs the Principal's actual signature —
        // nothing was joining school_admins in here before, which is why
        // the card always showed a broken/blank signature image
        // regardless of whether one had been uploaded. NULL if no
        // Principal row is on file yet, or that Principal hasn't
        // uploaded a signature — the frontend should treat that as "no
        // signature available" rather than guessing a filename.
        const [principalRows] = await pool.query(
            `SELECT signature_url, stamp_url FROM school_admins WHERE school_id = ? AND title = 'Principal' LIMIT 1`,
            [req.user.school_id]
        );
        profile.principal_signature_url = principalRows[0]?.signature_url || null;
        profile.principal_stamp_url = principalRows[0]?.stamp_url || null;

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
    top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
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
// Open to any school_admins account (Principal, Admin VP, or Academic
// VP) — not restricted to a specific title, since any of them checking
// in at school counts as physical presence for this purpose.
app.post('/api/attendance/checkin', requireAuth, requireRole('teachers', 'school_admins', 'registrar_users', 'students'), async (req, res) => {
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
app.post('/api/admin/mark-teacher-attendance', requireAuth, requireAdminTitle('Admin VP'), async (req, res) => {
    const { teacher_id, status } = req.body;
    if (!teacher_id || !['present', 'absent'].includes(status)) {
        return res.status(400).json({ error: "teacher_id and a valid status ('present' or 'absent') are required" });
    }
    try {
        const today = toDateOnly(new Date());
        // A holiday isn't a day anyone was expected to show up, so it
        // can't be logged against a teacher as an absence — same
        // principle as isSchoolDay() skipping holidays for students.
        const holidayName = getEthiopianHolidayName(new Date());
        if (status === 'absent' && holidayName) {
            return res.status(400).json({ error: `Today is ${holidayName} — a school holiday. Attendance can't be marked absent on a holiday.` });
        }
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
            const holidayName = getEthiopianHolidayName(cursor);
            if (termStartDate && dateStr < termStartDate) status = 'not_started';
            // Holiday takes priority over weekend so the widget can color
            // it distinctly (yellow) rather than lumping it in with an
            // ordinary Saturday/Sunday — a holiday that lands on a weekday
            // is exactly the case that used to get miscounted as absent.
            else if (holidayName) status = 'holiday';
            else if (!isSchoolDay(cursor)) status = 'weekend';
            else if (dateStr > today) status = 'future';
            else if (presentSet.has(dateStr)) status = 'present';
            else if (excusedSet.has(dateStr)) status = 'excused';
            else status = 'absent';
            days.push({ date: dateStr, status, holiday_name: holidayName || null });
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
                    s.subject_name, CONCAT_WS(' ', t.first_name, t.middle_name, t.last_name) AS teacher_name
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
// intentionally no way for anyone but school_admins to create, see the
// full list of, or revoke these rows.
async function isTeacherOnLeave(teacher_id, school_id, date) {
    const [rows] = await pool.query(
        `SELECT 1 FROM teacher_leave WHERE teacher_id = ? AND school_id = ? AND date_from <= ? AND date_to >= ? LIMIT 1`,
        [teacher_id, school_id, date, date]
    );
    return rows.length > 0;
}

app.post('/api/admin/teacher-leave', requireAuth, requireAdminTitle('Admin VP'), async (req, res) => {
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

app.get('/api/admin/teacher-leave', requireAuth, requireAdminTitle('Admin VP'), async (req, res) => {
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

app.delete('/api/admin/teacher-leave/:id', requireAuth, requireAdminTitle('Admin VP'), async (req, res) => {
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

// --- Teacher absence requests (teacher-initiated, unlike teacher_leave
// above which is Admin VP granting leave directly) ---
// A teacher requests time off; Admin VP can approve/reject it directly
// ONLY if it's 5 days or fewer. Anything longer is outside Admin VP's
// authority entirely — it's routed straight to the Principal at
// submission time (status starts as 'escalated', not 'pending'), the
// same "outside my authority, hand it up" shape as the student
// absence_requests → escalate → admin flow elsewhere in this file, just
// automatic here instead of a manual escalate step, since the 5-day line
// is a fixed rule rather than a judgment call.
//
// Requires a new table — run this migration if it doesn't exist yet:
//   CREATE TABLE teacher_absence_requests (
//     request_id INT AUTO_INCREMENT PRIMARY KEY,
//     teacher_id VARCHAR(50) NOT NULL,
//     school_id INT NOT NULL,
//     date_from DATE NOT NULL,
//     date_to DATE NOT NULL,
//     reason VARCHAR(255) NULL,
//     status ENUM('pending','approved','rejected','escalated') NOT NULL DEFAULT 'pending',
//     reviewed_by VARCHAR(50) NULL,
//     reviewed_at DATETIME NULL,
//     rejection_reason VARCHAR(255) NULL,
//     requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     INDEX idx_teacher_absence (teacher_id, school_id)
//   );
const ADMIN_VP_ABSENCE_AUTHORITY_DAYS = 5;

app.post('/api/teacher/absence-requests', requireAuth, requireRole('teachers'), async (req, res) => {
    const { date_from, date_to, reason } = req.body;
    if (!date_from || !date_to) {
        return res.status(400).json({ error: "date_from and date_to are required" });
    }
    if (new Date(date_to) < new Date(date_from)) {
        return res.status(400).json({ error: "date_to can't be before date_from." });
    }
    const spanDays = absenceRequestSpanDays(date_from, date_to);
    const status = spanDays > ADMIN_VP_ABSENCE_AUTHORITY_DAYS ? 'escalated' : 'pending';

    try {
        const [result] = await pool.query(
            `INSERT INTO teacher_absence_requests (teacher_id, school_id, date_from, date_to, reason, status)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [req.user.user_id, req.user.school_id, date_from, date_to, reason || null, status]
        );
        res.json({
            message: status === 'escalated'
                ? `Requests longer than ${ADMIN_VP_ABSENCE_AUTHORITY_DAYS} days go straight to the Principal for review.`
                : "Request submitted to Admin VP for review.",
            request_id: result.insertId,
            status
        });
    } catch (err) {
        console.error("/api/teacher/absence-requests POST error:", err);
        res.status(500).json({ error: "Could not submit absence request" });
    }
});

app.get('/api/teacher/absence-requests', requireAuth, requireRole('teachers'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT request_id, date_from, date_to, reason, status, rejection_reason, reviewed_by, reviewed_at, requested_at
             FROM teacher_absence_requests WHERE teacher_id = ? AND school_id = ? ORDER BY requested_at DESC`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/teacher/absence-requests GET error:", err);
        res.status(500).json({ error: "Could not load your absence requests" });
    }
});

// Admin VP's queue — pending requests only (5 days or fewer by
// definition, since anything longer was never set to 'pending' in the
// first place).
app.get('/api/admin/teacher-absence-requests', requireAuth, requireAdminTitle('Admin VP'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT r.request_id, r.teacher_id, t.first_name, t.last_name, r.date_from, r.date_to, r.reason, r.status, r.requested_at
             FROM teacher_absence_requests r
             JOIN teachers t ON t.teacher_id = r.teacher_id AND t.school_id = r.school_id
             WHERE r.school_id = ? AND r.status = 'pending'
             ORDER BY r.requested_at ASC`,
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/admin/teacher-absence-requests GET error:", err);
        res.status(500).json({ error: "Could not load pending absence requests" });
    }
});

app.post('/api/admin/teacher-absence-requests/:id/approve', requireAuth, requireAdminTitle('Admin VP'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT * FROM teacher_absence_requests WHERE request_id = ? AND school_id = ? AND status = 'pending'`,
            [req.params.id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Request not found or already reviewed." });
        const request = rows[0];

        // Approving actually grants the leave — same teacher_leave table
        // the direct-grant flow above uses, so it excuses the teacher's
        // period attendance for these dates exactly the same way.
        await pool.query(
            `INSERT INTO teacher_leave (teacher_id, school_id, date_from, date_to, reason, granted_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [request.teacher_id, req.user.school_id, request.date_from, request.date_to, request.reason, req.user.user_id]
        );
        await pool.query(
            `UPDATE teacher_absence_requests SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE request_id = ?`,
            [req.user.user_id, request.request_id]
        );
        res.json({ message: "Absence request approved and leave granted." });
    } catch (err) {
        console.error("/api/admin/teacher-absence-requests/:id/approve error:", err);
        res.status(500).json({ error: "Could not approve this request" });
    }
});

app.post('/api/admin/teacher-absence-requests/:id/reject', requireAuth, requireAdminTitle('Admin VP'), async (req, res) => {
    const { reason } = req.body;
    try {
        const [result] = await pool.query(
            `UPDATE teacher_absence_requests SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW()
             WHERE request_id = ? AND school_id = ? AND status = 'pending'`,
            [reason || null, req.user.user_id, req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Request not found or already reviewed." });
        res.json({ message: "Absence request rejected." });
    } catch (err) {
        console.error("/api/admin/teacher-absence-requests/:id/reject error:", err);
        res.status(500).json({ error: "Could not reject this request" });
    }
});

// --- Principal's queue: requests over Admin VP's 5-day authority ---
app.get('/api/principal/teacher-absence-requests', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT r.request_id, r.teacher_id, t.first_name, t.last_name, r.date_from, r.date_to, r.reason, r.status, r.requested_at
             FROM teacher_absence_requests r
             JOIN teachers t ON t.teacher_id = r.teacher_id AND t.school_id = r.school_id
             WHERE r.school_id = ? AND r.status = 'escalated'
             ORDER BY r.requested_at ASC`,
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/principal/teacher-absence-requests GET error:", err);
        res.status(500).json({ error: "Could not load escalated absence requests" });
    }
});

app.post('/api/principal/teacher-absence-requests/:id/approve', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT * FROM teacher_absence_requests WHERE request_id = ? AND school_id = ? AND status = 'escalated'`,
            [req.params.id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Request not found or not awaiting Principal review." });
        const request = rows[0];

        await pool.query(
            `INSERT INTO teacher_leave (teacher_id, school_id, date_from, date_to, reason, granted_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [request.teacher_id, req.user.school_id, request.date_from, request.date_to, request.reason, req.user.user_id]
        );
        await pool.query(
            `UPDATE teacher_absence_requests SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE request_id = ?`,
            [req.user.user_id, request.request_id]
        );
        res.json({ message: "Absence request approved and leave granted." });
    } catch (err) {
        console.error("/api/principal/teacher-absence-requests/:id/approve error:", err);
        res.status(500).json({ error: "Could not approve this request" });
    }
});

app.post('/api/principal/teacher-absence-requests/:id/reject', requireAuth, requirePrincipal, async (req, res) => {
    const { reason } = req.body;
    try {
        const [result] = await pool.query(
            `UPDATE teacher_absence_requests SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW()
             WHERE request_id = ? AND school_id = ? AND status = 'escalated'`,
            [reason || null, req.user.user_id, req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Request not found or not awaiting Principal review." });
        res.json({ message: "Absence request rejected." });
    } catch (err) {
        console.error("/api/principal/teacher-absence-requests/:id/reject error:", err);
        res.status(500).json({ error: "Could not reject this request" });
    }
});

// --- Principal: school-wide "students on leave" view ---
// Every approved absence_requests row, school-wide — whether the approval
// came from a homeroom teacher directly or from Academic VP after
// escalation. currently_on_leave flags the ones whose date range covers
// today, so the dashboard can show an at-a-glance count while this full
// list (opened from that same widget) also covers ones already granted
// in the past or scheduled for the future.
app.get('/api/principal/students-on-leave', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT r.request_id, r.student_id, r.date_from, r.date_to, r.reason,
                    st.first_name, st.middle_name, st.last_name, st.class_level, st.section, st.stream,
                    (CURDATE() BETWEEN r.date_from AND r.date_to) AS currently_on_leave
             FROM absence_requests r
             JOIN students st ON st.student_id = r.student_id AND st.school_id = r.school_id
             WHERE r.school_id = ? AND r.status = 'approved'
             ORDER BY currently_on_leave DESC, r.date_from DESC`,
            [req.user.school_id]
        );
        res.json(rows.map(r => ({ ...r, currently_on_leave: !!r.currently_on_leave })));
    } catch (err) {
        console.error("/api/principal/students-on-leave error:", err);
        res.status(500).json({ error: "Could not load students on leave" });
    }
});

// --- Principal: school-wide performance breakdown, for the dashboard pie
// charts. Covers four angles: (1) academic — every currently-enrolled
// student's average score this term; (2) student attendance — present vs
// excused vs unexcused absence over the trailing 30 school days (Mon-Fri);
// (3) teacher attendance — same present/excused/unexcused split, but off
// teacher_attendance's explicit daily marking instead of inferring absence
// from a missing row; (4) teacher class coverage — of every timetabled
// period in the last 30 days, how many did the teacher actually show up
// to teach (period_attendance_log.teacher_present), i.e. "not teaching in
// class" instances. (2)-(4) intentionally mirror the exact same tables
// and 30-day window /api/principal/teacher-audit already uses, so the two
// widgets never disagree with each other.
function weekdaysBetween(startStr, endStr) {
    // Inclusive count of Mon-Fri dates in [startStr, endStr] — matches the
    // school week used by the Timetable builder (days 1-5 = Mon-Fri).
    let count = 0;
    const cur = new Date(startStr + 'T00:00:00Z');
    const end = new Date(endStr + 'T00:00:00Z');
    while (cur <= end) {
        const day = cur.getUTCDay(); // 0=Sun ... 6=Sat
        if (day >= 1 && day <= 5) count++;
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return count;
}

// Same as weekdaysBetween, but also excludes Ethiopian calendar
// holidays — used anywhere an "expected attendance slots" total is
// computed, so a school-wide holiday doesn't get counted as a day
// everyone should have shown up and silently inflate the unexcused
// count for both students and teachers.
function schoolDaysBetween(startStr, endStr) {
    let count = 0;
    const cur = new Date(startStr + 'T00:00:00Z');
    const end = new Date(endStr + 'T00:00:00Z');
    while (cur <= end) {
        const day = cur.getUTCDay();
        if (day >= 1 && day <= 5 && !isEthiopianHoliday(cur)) count++;
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return count;
}

// Shared by the live /api/principal/school-performance endpoint below and
// by archiveSchoolPerformance() (see the Semester Archive section near
// POST /api/term/close) — both need the exact same four-angle breakdown,
// just over a different [since, until] window, so the numbers a Principal
// sees live and the numbers frozen into last semester's archive are always
// computed the same way.
async function computeSchoolPerformance(school_id, since, today, currentTerm) {
    const schoolDays30 = schoolDaysBetween(since, today);

    // (1) Academic performance
    const [markRows] = await pool.query(
        `SELECT st.student_id, AVG(m.score) AS avg_score
         FROM students st
         LEFT JOIN marks m ON m.student_id = st.student_id AND m.school_id = st.school_id AND m.term = ?
         WHERE st.school_id = ? AND st.status NOT IN ('Graduated') AND st.status NOT LIKE 'Transferred%'
         GROUP BY st.student_id`,
        [currentTerm, school_id]
    );
    const academic = { good: 0, average: 0, poor: 0, none: 0 };
    for (const r of markRows) {
        if (r.avg_score == null) academic.none++;
        else if (Number(r.avg_score) >= 75) academic.good++;
        else if (Number(r.avg_score) >= 50) academic.average++;
        else academic.poor++;
    }

    // (2) Student attendance — present rows are explicit; absence isn't
    // (student_attendance only ever stores 'present'), so unexcused is
    // whatever's left after subtracting present days and any days
    // covered by an approved absence request, out of the total
    // school-day "slots" (school days × currently-enrolled students).
    const [[{ enrolled_count }]] = await pool.query(
        `SELECT COUNT(*) AS enrolled_count FROM students
         WHERE school_id = ? AND status NOT IN ('Graduated') AND status NOT LIKE 'Transferred%'`,
        [school_id]
    );
    const totalStudentSlots = schoolDays30 * Number(enrolled_count);

    const [[{ student_present }]] = await pool.query(
        `SELECT COUNT(*) AS student_present FROM student_attendance
         WHERE school_id = ? AND status = 'present' AND attendance_date BETWEEN ? AND ?`,
        [school_id, since, today]
    );

    const [studentLeaveRows] = await pool.query(
        `SELECT date_from, date_to FROM absence_requests
         WHERE school_id = ? AND status = 'approved' AND date_from <= ? AND date_to >= ?`,
        [school_id, today, since]
    );
    let studentExcused = 0;
    for (const r of studentLeaveRows) {
        const rFrom = toDateOnly(new Date(r.date_from));
        const rTo = toDateOnly(new Date(r.date_to));
        const overlapFrom = rFrom > since ? rFrom : since;
        const overlapTo = rTo < today ? rTo : today;
        if (overlapFrom <= overlapTo) studentExcused += schoolDaysBetween(overlapFrom, overlapTo);
    }
    const studentUnexcused = Math.max(0, totalStudentSlots - Number(student_present) - studentExcused);
    const studentAttendance = { present: Number(student_present), excused: studentExcused, unexcused: studentUnexcused };

    // (3) Teacher attendance — teacher_attendance marks 'present'/
    // 'absent' explicitly each day, so an absent row is "excused" only
    // if it falls inside an approved teacher_absence_requests range.
    const [[{ teacher_present }]] = await pool.query(
        `SELECT COUNT(*) AS teacher_present FROM teacher_attendance
         WHERE school_id = ? AND status = 'present' AND attendance_date BETWEEN ? AND ?`,
        [school_id, since, today]
    );
    const [[{ teacher_excused_absent }]] = await pool.query(
        `SELECT COUNT(*) AS teacher_excused_absent FROM teacher_attendance ta
         WHERE ta.school_id = ? AND ta.status = 'absent' AND ta.attendance_date BETWEEN ? AND ?
           AND EXISTS (
               SELECT 1 FROM teacher_absence_requests tar
               WHERE tar.teacher_id = ta.teacher_id AND tar.school_id = ta.school_id
                 AND tar.status = 'approved' AND ta.attendance_date BETWEEN tar.date_from AND tar.date_to
           )`,
        [school_id, since, today]
    );
    const [[{ teacher_absent_total }]] = await pool.query(
        `SELECT COUNT(*) AS teacher_absent_total FROM teacher_attendance
         WHERE school_id = ? AND status = 'absent' AND attendance_date BETWEEN ? AND ?`,
        [school_id, since, today]
    );
    const teacherAttendance = {
        present: Number(teacher_present),
        excused: Number(teacher_excused_absent),
        unexcused: Math.max(0, Number(teacher_absent_total) - Number(teacher_excused_absent))
    };

    // (4) Teacher class coverage — of every timetabled period logged
    // in the last 30 days, how many did the teacher actually teach
    // (Class Monitor's period_attendance_log.teacher_present) vs miss.
    const [[{ periods_taught, periods_total }]] = await pool.query(
        `SELECT COALESCE(SUM(teacher_present), 0) AS periods_taught, COUNT(*) AS periods_total
         FROM period_attendance_log WHERE school_id = ? AND log_date BETWEEN ? AND ?`,
        [school_id, since, today]
    );
    const classCoverage = {
        taught: Number(periods_taught),
        missed: Number(periods_total) - Number(periods_taught)
    };

    return {
        term: currentTerm,
        window: { since, until: today, school_days: schoolDays30 },
        academic: { total: markRows.length, ...academic },
        student_attendance: studentAttendance,
        teacher_attendance: teacherAttendance,
        class_coverage: classCoverage
    };
}

app.get('/api/principal/school-performance', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const currentTerm = await getCurrentTerm(req.user.school_id);
        const today = toDateOnly(new Date());
        const rawSince = toDateOnly(new Date(Date.now() - 30 * 86400000));
        // Never let the live widgets bleed into the previous semester's
        // numbers once a new one has started — clamp the trailing-30-day
        // window to the declared start of the CURRENT term (see
        // getTermStartDate). Right after "Start Semester" is pressed this
        // collapses the window down to just today, so every chart reads as
        // empty/reset and then fills back in day by day — last semester's
        // frozen totals live on separately in semester_archives instead
        // (see /api/principal/last-semester-performance below).
        const termStartDate = await getTermStartDate(req.user.school_id);
        const since = (termStartDate && termStartDate > rawSince) ? termStartDate : rawSince;

        const snapshot = await computeSchoolPerformance(req.user.school_id, since, today, currentTerm);
        res.json(snapshot);
    } catch (err) {
        console.error("/api/principal/school-performance error:", err);
        res.status(500).json({ error: "Could not load school performance" });
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
                    CONCAT_WS(' ', t.first_name, t.middle_name, t.last_name) AS teacher_name,
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
// exists to produce. Open to any school_admins account (title is
// available on req.user.title now if you want to tighten this to a
// specific title like Academic VP later).
app.get('/api/admin/teacher-punctuality', requireAuth, requireAdminTitle('Admin VP'), async (req, res) => {
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
// Open to any school_admins account for now — there's no dedicated
// "Academic Coordinator" title distinction yet, though title is on
// req.user if you want to add one later. This is a bare CRUD with no timetable-builder UI
// behind it yet either; it exists so the table can actually be populated
// (e.g. via a quick admin script or Postman) before the teacher/admin
// site has a proper screen for it.
app.get('/api/admin/timetable', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
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

app.post('/api/admin/timetable', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
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

app.delete('/api/admin/timetable/:id', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
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
app.post('/api/attendance/manual-checkin', requireAuth, requireRole('teachers', 'school_admins', 'registrar_users', 'students'), async (req, res) => {
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
            `SELECT student_id, first_name, middle_name, last_name FROM students
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
            name: [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' '),
            present: presentSet.has(s.student_id),
            absence_request_status: excusedMap.get(s.student_id) || null
        }));

        res.json({
            date,
            roster,
            absent_count: roster.filter(r => !r.present).length,
            is_holiday: !!getEthiopianHolidayName(date),
            holiday_name: getEthiopianHolidayName(date)
        });
    } catch (err) {
        console.error("/api/student/my-class-attendance error:", err);
        res.status(500).json({ error: "Could not load class attendance" });
    }
});

// --- Certificate PDF generation ---
// Each document type lives in its own subfolder under templates/ (e.g.
// templates/certificate/certificate.html, templates/transcript/transcript.html)
// rather than as flat files directly in templates/ — matches how the
// templates folder is actually laid out on disk.
const CERTIFICATE_TEMPLATE_PATH = path.join(__dirname, 'templates', 'certificate', 'certificate.html');
const TRANSCRIPT_TEMPLATE_PATH = path.join(__dirname, 'templates', 'transcript', 'transcript.html');
const RECOMMENDATION_TEMPLATE_PATH = path.join(__dirname, 'templates', 'recommendation', 'recommendation.html');

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

// The CURRENT academic year for header display, e.g. "2018 E.C. (2025/26 GC)".
// An Ethiopian academic year straddles two Gregorian years (starts ~Sept,
// ends ~July), so unlike approximateEthiopianYear() above (a single EC
// year for a specific past date on a document), this always describes
// "right now" and always shows both GC years it spans, regardless of
// which side of the Sept 11 cutoff today happens to fall on.
function getCurrentAcademicYearLabel() {
    const today = new Date();
    const ecYear = approximateEthiopianYear(today);
    // The Gregorian year the current EC year started in (Sept of that year).
    const gcStart = ecYear + 7;
    const gcEndShort = String((gcStart + 1) % 100).padStart(2, '0');
    return {
        ec_year: ecYear,
        gc_range: `${gcStart}/${gcEndShort}`,
        label: `${ecYear} E.C. (${gcStart}/${gcEndShort} GC)`
    };
}

// Full Ethiopian date conversion for message text (e.g. absence
// notifications), not just the approximate year above. Same
// Julian-Day-Number method as toEthiopianDate in script.js — kept as a
// separate copy here since this runs server-side (Node) rather than in
// the browser, but the math is identical so the two stay in sync.
const ETHIOPIAN_MONTHS = ['Meskerem', 'Tikimt', 'Hidar', 'Tahsas', 'Tir', 'Yekatit', 'Megabit', 'Miazia', 'Ginbot', 'Sene', 'Hamle', 'Nehase', 'Pagume'];
const JD_EPOCH_OFFSET_AMETE_MIHRET = 1723856;

function gregorianToJdn(year, month, day) {
    const a = Math.floor((14 - month) / 12);
    const y = year + 4800 - a;
    const m = month + 12 * a - 3;
    return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

function toEthiopianDate(dateInput) {
    const d = new Date(dateInput);
    const jdn = gregorianToJdn(d.getFullYear(), d.getMonth() + 1, d.getDate());
    const r = (jdn - JD_EPOCH_OFFSET_AMETE_MIHRET) % 1461;
    const n = (r % 365) + 365 * Math.floor(r / 1460);
    const year = 4 * Math.floor((jdn - JD_EPOCH_OFFSET_AMETE_MIHRET) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460);
    const month = Math.floor(n / 30) + 1;
    const day = (n % 30) + 1;
    return { year, month, day, monthName: ETHIOPIAN_MONTHS[month - 1] };
}

// Plain-text dual-calendar date for message strings (portal-wide
// convention: Ethiopian first, GC in brackets) — e.g.
// "12 Hamle 2018 E.C. (30 Jul 2026 GC)". No HTML here, since these
// strings get inserted as plain text (escapeHtml'd) in the notifications
// list, unlike the table-cell version in script.js.
function formatDualDateText(dateInput) {
    const d = new Date(dateInput);
    const e = toEthiopianDate(d);
    const gc = d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
    return `${e.day} ${e.monthName} ${e.year} E.C. (${gc} GC)`;
}

// --- Ethiopian calendar holidays — shared by isSchoolDay() (so no one's
// attendance is dinged for a day the school itself was closed) and by
// the attendance-calendar/holiday-aware endpoints below (so the UI can
// color a holiday distinctly from an ordinary weekend). Mirrors the
// client-side ETH_CAL_FIXED_HOLIDAYS/ETH_CAL_MOVABLE_HOLIDAYS tables in
// script.js's dashboard widget — keep the two in sync if either changes.
//
// Fixed holidays never move relative to the Ethiopian calendar, so
// they're stored as [ec_month, ec_day] and matched directly against
// toEthiopianDate()'s output — no year-specific Gregorian conversion
// needed.
const ETH_FIXED_HOLIDAYS = [
    { md: [1, 1], name: 'Enkutatash (New Year)' },
    { md: [1, 17], name: 'Meskel (Finding of the True Cross)' },
    { md: [12, 13], name: 'Buhe' },
    { md: [4, 29], name: 'Genna (Ethiopian Christmas)' },
    { md: [5, 11], name: 'Timkat (Epiphany)' },
    { md: [6, 23], name: 'Adwa Victory Day' },
    { md: [8, 23], name: 'International Labor Day' },
    { md: [8, 27], name: "Patriots' Victory Day" },
    { md: [9, 20], name: 'Derg Downfall Day' }
];

// Movable (lunar/paschal) holidays don't have a fixed Ethiopian-calendar
// month/day, so they're kept as explicit Gregorian dates per year
// instead of being derived. Extend this table as future years are
// needed — a year with no entry here simply has no movable holidays
// recognized, rather than a guessed date.
const ETH_MOVABLE_HOLIDAYS = {
    2026: [
        { md: [3, 20], name: 'Eid al-Fitr' },
        { md: [5, 27], name: 'Eid al-Adha' },
        { md: [8, 26], name: "Mawlid (The Prophet's Birthday)" },
        { md: [4, 3], name: 'Ethiopian Good Friday (Siklet)' },
        { md: [4, 5], name: 'Fasika (Ethiopian Easter)' }
    ],
    2027: [
        { md: [3, 9], name: 'Eid al-Fitr' },
        { md: [5, 16], name: 'Eid al-Adha' },
        { md: [8, 15], name: "Mawlid (The Prophet's Birthday)" },
        { md: [4, 30], name: 'Ethiopian Good Friday (Siklet)' },
        { md: [5, 2], name: 'Fasika (Ethiopian Easter)' }
    ]
};

// Returns the holiday name if `date` is an Ethiopian calendar holiday,
// or null otherwise. Checks fixed EC holidays via toEthiopianDate() (so
// no Gregorian conversion is needed) and movable holidays via the
// explicit per-Gregorian-year table above.
function getEthiopianHolidayName(date) {
    const d = new Date(date);
    const ec = toEthiopianDate(d);
    const fixed = ETH_FIXED_HOLIDAYS.find(h => h.md[0] === ec.month && h.md[1] === ec.day);
    if (fixed) return fixed.name;
    const movable = (ETH_MOVABLE_HOLIDAYS[d.getFullYear()] || [])
        .find(h => h.md[0] === d.getMonth() + 1 && h.md[1] === d.getDate());
    return movable ? movable.name : null;
}

function isEthiopianHoliday(date) {
    return getEthiopianHolidayName(date) !== null;
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

// Renders an uploaded signature (a homeroom teacher's teachers.signature_url,
// or the Principal's school_admins.signature_url) as a small base64 image
// dropped just above the blank .rule line already in the template. Unlike
// buildPhotoHtml there's no "missing" placeholder — an empty signing line is
// a perfectly normal state (student sheet not yet signed off), so this just
// returns '' and the template's blank line stands on its own.
function buildSignatureHtml(signatureUrl) {
    if (!signatureUrl) return '';
    try {
        const sigPath = path.join(__dirname, 'uploads', path.basename(signatureUrl));
        const buf = fs.readFileSync(sigPath);
        const ext = path.extname(sigPath).slice(1).toLowerCase();
        const mime = { png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg';
        return `<img class="sig-img" src="data:${mime};base64,${buf.toString('base64')}" alt="Signature">`;
    } catch (err) {
        console.error('signature image read failed:', err);
        return '';
    }
}

// Shared by buildPhotoHtml/buildSignatureHtml/buildSchoolSealHtml/
// buildStampWatermarkHtml: page.setContent() has no base URL or network
// access mid-render, so every uploaded image on these templates goes in
// as a base64 data URI rather than a plain <img src="/uploads/...">.
// Returns null (not a placeholder) on anything missing/unreadable — each
// caller decides its own fallback.
function readUploadedImageAsDataUri(fileUrl) {
    if (!fileUrl) return null;
    try {
        const filePath = path.join(__dirname, 'uploads', path.basename(fileUrl));
        const buf = fs.readFileSync(filePath);
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const mime = { png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg';
        return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err) {
        console.error('uploaded image read failed:', fileUrl, err);
        return null;
    }
}

// The seal-slot in the middle of the sign-strip: the Principal's uploaded
// school_admins.stamp_url rendered as a round seal image when one's on
// file, falling back to the original dashed "School / Seal" placeholder
// ring when it isn't.
function buildSchoolSealHtml(stampUrl) {
    const dataUri = readUploadedImageAsDataUri(stampUrl);
    if (!dataUri) return '<div class="seal-ring">School<br>Seal</div>';
    return `<div class="seal-ring seal-ring-img"><img class="seal-img" src="${dataUri}" alt="School Seal"></div>`;
}

// The same stamp image, stamped translucently over the Principal's
// printed name (the way a physical school stamp is pressed over a
// signatory's name on a paper document) — empty string, i.e. no
// watermark, when no stamp has been uploaded.
function buildStampWatermarkHtml(stampUrl) {
    const dataUri = readUploadedImageAsDataUri(stampUrl);
    if (!dataUri) return '';
    return `<img class="stamp-watermark" src="${dataUri}" alt="">`;
}

// Fills the server-side certificate template (templates/certificate.html,
// never served directly — see the route below) with one student's real
// data via plain token replacement. The template's own <script> still
// does all the per-subject math (totals, averages, ratings) exactly as
// designed; this only injects the raw numbers and bio/school text.
function renderCertificateHtml(data) {
    let html = fs.readFileSync(CERTIFICATE_TEMPLATE_PATH, 'utf8');
    // Same reasoning as renderTranscriptHtml/renderRecommendationHtml below:
    // page.setContent() has no base URL, so the template's own relative
    // <link>, <script src>, and flag <img src> tags all need inlining or
    // they silently fail to load — no styling, no marks table, no flags.
    html = inlineStylesheet(html, 'certificate.css', path.join(__dirname, 'templates', 'certificate', 'certificate.css'));
    html = inlineImage(html, '../../public/assets/images/gambella_flag.png', path.join(__dirname, 'public', 'assets', 'images', 'gambella_flag.png'));
    html = inlineImage(html, '../../public/assets/images/ethiopia_flag.png', path.join(__dirname, 'public', 'assets', 'images', 'ethiopia_flag.png'));

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
        __HOMEROOM_TEACHER_NAME__: escapeHtml(data.homeroom_teacher_name || '—'),
        __HOMEROOM_SIGNATURE_HTML__: data.homeroom_signature_html || '',
        __PRINCIPAL_NAME__: escapeHtml(data.principal_name || '—'),
        __PRINCIPAL_SIGNATURE_HTML__: data.principal_signature_html || '',
        __SCHOOL_SEAL_HTML__: data.school_seal_html || '<div class="seal-ring">School<br>Seal</div>',
        __PRINCIPAL_STAMP_WATERMARK_HTML__: data.principal_stamp_watermark_html || ''
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
    // split/join, not .replace() — replace() treats "$&", "$$", "$1" etc.
    // in the replacement string as special patterns, so any field that
    // happens to contain a literal "$" (a subject name, verify_url, ...)
    // would silently corrupt the injected JSON and break the whole inline
    // script — producing exactly a blank marks table AND a missing QR
    // code, since QR rendering lives further down the same script chain.
    html = html.split('__CERT_DATA_JSON__').join(dataJson);
    html = inlineScript(html, 'certificate.js', path.join(__dirname, 'templates', 'certificate', 'certificate.js'));

    return html;
}

// Inlines a template's own stylesheet as a <style> block in place of its
// relative <link>, so page.setContent() (which has no base URL to
// resolve a relative href against) still renders it styled.
function inlineStylesheet(html, cssFilename, cssPath) {
    const css = fs.readFileSync(cssPath, 'utf8');
    const linkRe = new RegExp(`<link[^>]*href=["']${cssFilename}["'][^>]*>`);
    return html.replace(linkRe, `<style>${css}</style>`);
}

// Same problem, same fix, for a template's own <script src="...">.
function inlineScript(html, jsFilename, jsPath) {
    const js = fs.readFileSync(jsPath, 'utf8');
    const scriptRe = new RegExp(`<script[^>]*src=["']${jsFilename}["'][^>]*></script>`);
    return html.replace(scriptRe, `<script>${js}</script>`);
}

// Same problem, same fix, for a template's own <img src="relative/path">
// (e.g. certificate.html's regional/national flag images) — page.setContent()
// has no base URL to resolve a relative src against, so every occurrence
// of that exact src is swapped for a base64 data URI instead.
function inlineImage(html, srcPath, imagePath) {
    const buf = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).slice(1).toLowerCase();
    const mime = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'image/jpeg';
    const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
    return html.split(`src="${srcPath}"`).join(`src="${dataUri}"`);
}

// Fills templates/transcript.html — the 4-year (Grade 9-12) grid, as
// opposed to certificate.html's single-year marks sheet. All row
// building happens client-side in transcript.js; this just ships the
// one JSON blob it reads from.
function renderTranscriptHtml(data) {
    let html = fs.readFileSync(TRANSCRIPT_TEMPLATE_PATH, 'utf8');
    html = inlineStylesheet(html, 'transcript.css', path.join(__dirname, 'templates', 'transcript', 'transcript.css'));
    // Same reasoning as renderCertificateHtml: page.setContent() has no
    // base URL, so these relative <img src> paths can never resolve on
    // their own — without this, the flags just silently fail to render.
    html = inlineImage(html, '../../public/assets/images/gambella_flag.png', path.join(__dirname, 'public', 'assets', 'images', 'gambella_flag.png'));
    html = inlineImage(html, '../../public/assets/images/ethiopia_flag.png', path.join(__dirname, 'public', 'assets', 'images', 'ethiopia_flag.png'));
    const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
    // split/join, not .replace() — see the matching comment in
    // renderCertificateHtml for why .replace() is unsafe here.
    html = html.split('__TRANSCRIPT_DATA_JSON__').join(dataJson);
    html = inlineScript(html, 'transcript.js', path.join(__dirname, 'templates', 'transcript', 'transcript.js'));
    return html;
}

// Fills templates/recommendation.html — the School's Recommendation
// letter (principal sign-off + per-semester homeroom/parent comments).
function renderRecommendationHtml(data) {
    let html = fs.readFileSync(RECOMMENDATION_TEMPLATE_PATH, 'utf8');
    html = inlineStylesheet(html, 'recommendation.css', path.join(__dirname, 'templates', 'recommendation', 'recommendation.css'));
    const tokens = {
        __SCHOOL_NAME__: escapeHtml(data.school_name || 'School'),
        __STUDENT_NAME__: escapeHtml(data.student_name),
        __GRADE__: escapeHtml(data.grade),
        __SECTION__: escapeHtml(data.section),
        __STUDENT_ID__: escapeHtml(data.student_id),
        __ACADEMIC_YEAR__: escapeHtml(data.academic_year || '—'),
        __FIRST_SEMESTER_COMMENT__: escapeHtml(data.recommendation.first_semester_comment || ''),
        __FIRST_HOMEROOM_TEACHER_NAME__: escapeHtml(data.recommendation.first_semester_home_room_teacher || ''),
        __FIRST_PARENT_NAME__: escapeHtml(data.recommendation.first_semester_parent_name || ''),
        __SECOND_SEMESTER_COMMENT__: escapeHtml(data.recommendation.second_semester_comment || ''),
        __SECOND_HOMEROOM_TEACHER_NAME__: escapeHtml(data.recommendation.second_semester_home_room_teacher || ''),
        __SECOND_PARENT_NAME__: escapeHtml(data.recommendation.second_semester_parent_name || '')
    };
    for (const [token, value] of Object.entries(tokens)) {
        html = html.split(token).join(value);
    }
    const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
    html = html.replace('__RECOMMENDATION_DATA__', dataJson);
    html = inlineScript(html, 'recommedation.js', path.join(__dirname, 'templates', 'recommendation', 'recommedation.js'));
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

    // student_enrollment_history can lag behind a student's actual current
    // placement (it's only written on certain transitions), so a student
    // can have real marks already pushed for their current class/section/
    // stream with no matching history row at all. Left unhandled, that
    // silently reads as "no marks exist" — an empty subjects table and a
    // blank Academic Year on an otherwise fully-signed report card. So the
    // student's CURRENT placement is always checked too, synthesizing the
    // missing history row(s) when needed; everything below this point
    // (sync detection, rank, absences, subject scores) is keyed off
    // class_level/section/stream/term, not off where the row came from,
    // so a synthesized row is handled identically to a real one.
    const [currentRows] = await pool.query(
        `SELECT class_level, section, stream FROM students WHERE student_id = ? AND school_id = ?`,
        [student_id, school_id]
    );
    if (currentRows.length > 0) {
        const cur = currentRows[0];
        ['Semester 1', 'Semester 2'].forEach(term => {
            const alreadyThere = historyRows.some(h =>
                h.class_level === cur.class_level && h.section === cur.section && h.stream === cur.stream && h.term === term);
            if (!alreadyThere) historyRows.push({ class_level: cur.class_level, section: cur.section, stream: cur.stream, term });
        });
    }

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

// Shared with the report card route's inline version of this same
// classification — Natural/Social bucket by keyword match, everything
// else (including a plain "General" stream, Grade 9/10, or no stream at
// all) falls into 'General'. A subject's own `stream` column is either
// one of these three buckets (stream-restricted) or NULL (an
// All-Streams subject — English, Math, IT, etc. — visible in every
// bucket).
function streamBucketFor(streamText) {
    return /natural/i.test(streamText || '') ? 'Natural' : /social/i.test(streamText || '') ? 'Social' : 'General';
}

// Subject Configuration can (and often does) have the same subject_name
// configured more than once with a different stream — e.g. "Physics"
// entered once for General and again for Natural, matching how a real
// school's subject list actually looks. A naive `.map()` over the raw
// rows would then print that subject twice (once applicable, once
// blanked/struck-through) on the certificate/report card/transcript.
// This collapses the raw `subjects` rows down to one entry per
// subject_name, keeping it "applicable" if ANY of its configured rows
// matches the student's stream bucket (or is stream = NULL, i.e.
// visible in every bucket).
function dedupeSubjectsForStream(allSubjects, streamBucket) {
    const bySubject = new Map();
    allSubjects.forEach(subj => {
        const applicableHere = subj.stream === null || subj.stream === streamBucket;
        const existing = bySubject.get(subj.subject_name);
        if (!existing || (!existing.applicable && applicableHere)) {
            bySubject.set(subj.subject_name, { subject_name: subj.subject_name, applicable: applicableHere });
        }
    });
    return [...bySubject.values()];
}

// Removing a subject_dictionary entry deliberately doesn't touch a
// school's already-saved Subject Configuration rows (see the DELETE
// /api/zonal/subject-dictionary comment) — that's the right call for
// Subject Configuration itself, so a school doesn't silently lose its
// setup just because the zone retired a name. But it means a stale
// subject can otherwise keep appearing on freshly-generated documents
// indefinitely. This filters a school's raw `subjects` rows down to
// only the names still present in its zone's current dictionary, so
// certificates/report cards/transcripts reflect the zone's *current*
// curriculum. Matched case/whitespace-insensitively, since the
// dictionary and Subject Configuration are free-text entered by two
// different people (Head of Education vs Academic VP) and don't
// enforce identical casing against each other.
async function filterToZoneDictionary(subjectRows, school_id) {
    const zone_id = await getSchoolZoneId(school_id);
    if (!zone_id) return subjectRows; // no zone assigned yet — nothing to filter against
    const [dictRows] = await pool.query('SELECT subject_name FROM subject_dictionary WHERE zone_id = ?', [zone_id]);
    if (dictRows.length === 0) return subjectRows; // dictionary not set up yet — don't hide everything a school already configured
    const dictNames = new Set(dictRows.map(r => r.subject_name.trim().toLowerCase()));
    return subjectRows.filter(s => dictNames.has(s.subject_name.trim().toLowerCase()));
}

// One entry per class level the student has ANY history for — even a
// class level with no marks synced at all still gets an entry, with
// null in every field a real value would otherwise occupy. Documents
// are meant to be viewable/issuable at any point, not just once a
// year is fully synced; a blank field on the printed page is the
// correct way to show "not entered yet", not a reason to refuse to
// generate the document.
async function buildYearSummaries(student_id, school_id, terms) {
    const classLevels = [...new Set(terms.map(t => t.class_level))];
    // Same source as Subject Configuration / the report card route: the
    // transcript's subject list per year should be exactly "what the
    // Academic VP has configured, applicable to that year's stream" —
    // not just whatever happens to already have a synced score. A
    // subject with stream = NULL applies to every bucket (General,
    // Natural, Social) — that's how a school-wide subject like English,
    // Math, or IT is meant to be configured once and show up everywhere.
    const [allSubjectsRaw] = await pool.query(
        `SELECT subject_name, stream FROM subjects WHERE school_id = ? ORDER BY subject_name`,
        [school_id]
    );
    const allSubjects = await filterToZoneDictionary(allSubjectsRaw, school_id);
    const summaries = await Promise.all(classLevels.map(async (class_level) => {
        const s1 = terms.find(t => t.class_level === class_level && t.term === 'Semester 1');
        const s2 = terms.find(t => t.class_level === class_level && t.term === 'Semester 2');
        const yearStream = (s2 || s1)?.stream ?? null;
        const streamBucket = streamBucketFor(yearStream);

        const dedupedSubjects = dedupeSubjectsForStream(allSubjects, streamBucket);
        const configuredNames = new Set(dedupedSubjects.map(s => s.subject_name));
        const subjects = dedupedSubjects.map(subj => {
            const applicable = subj.applicable;
            const s1v = applicable ? (s1?.subjects.find(s => s.subject_name === subj.subject_name)?.total_score ?? null) : null;
            const s2v = applicable ? (s2?.subjects.find(s => s.subject_name === subj.subject_name)?.total_score ?? null) : null;
            return {
                subject_name: subj.subject_name,
                semester_1: s1v != null ? Number(s1v) : null,
                semester_2: s2v != null ? Number(s2v) : null,
                year_average: yearAverage(s1v, s2v),
                applicable
            };
        });
        // A subject with real historical scores but no longer present in
        // Subject Configuration (removed/renamed since) still needs to
        // show — that mark was genuinely earned that year — same
        // fallback reasoning as the report card route.
        const extraNames = [...new Set([...(s1?.subjects || []), ...(s2?.subjects || [])].map(s => s.subject_name))]
            .filter(name => !configuredNames.has(name)).sort();
        extraNames.forEach(name => {
            const s1v = s1?.subjects.find(s => s.subject_name === name)?.total_score ?? null;
            const s2v = s2?.subjects.find(s => s.subject_name === name)?.total_score ?? null;
            subjects.push({
                subject_name: name,
                semester_1: s1v != null ? Number(s1v) : null,
                semester_2: s2v != null ? Number(s2v) : null,
                year_average: yearAverage(s1v, s2v),
                applicable: true
            });
        });

        // Section-wide rank only means something once the whole
        // section's year is synced — leave it null otherwise rather
        // than ranking against an incomplete picture.
        let rank = null, class_size = null;
        if (s1?.synced && s2?.synced) {
            const sectionAverages = await getSectionYearAverages(school_id, class_level, s2.section, s2.stream);
            const ranks = rankStudents(sectionAverages);
            const mine = ranks.get(String(student_id));
            if (mine) { rank = mine.rank; class_size = mine.class_size; }
        }

        return {
            class_level,
            section: (s2 || s1)?.section ?? null,
            stream: (s2 || s1)?.stream ?? null,
            subjects,
            year_average: overallAverage(subjects.filter(s => s.applicable).map(s => s.year_average)),
            rank,
            class_size,
            days_absent: (s1?.days_absent ?? 0) + (s2?.days_absent ?? 0)
        };
    }));
    return summaries;
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
                    sc.school_name, z.zone_name AS zone, w.woreda_name AS woreda, r.region_name AS region
             FROM students st
             LEFT JOIN schools sc ON sc.id = st.school_id
             LEFT JOIN zone z ON z.zone_id = sc.zone_id
             LEFT JOIN woreda w ON w.woreda_id = sc.woreda_id
             LEFT JOIN region r ON r.region_id = sc.region_id
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

        // Same full-sheet treatment as the Registrar's report card: show
        // every subject the school teaches (so an out-of-stream subject
        // still appears, struck through by certificate.js, rather than
        // silently vanishing) and blank the marks for any subject outside
        // the student's own stream, even if a stray score exists for it.
        // subjects.stream is the short 'Natural'/'Social'/'General'/NULL
        // bucket; students.stream is the longer 'Natural Science'/'Social
        // Science' label, so match by substring rather than equality.
        const [allSubjectsRaw] = await pool.query(
            `SELECT subject_name, stream FROM subjects WHERE school_id = ? ORDER BY subject_name`,
            [req.user.school_id]
        );
        const allSubjects = await filterToZoneDictionary(allSubjectsRaw, req.user.school_id);
        const streamBucket = /natural/i.test(s2.stream || '') ? 'Natural' : /social/i.test(s2.stream || '') ? 'Social' : 'General';
        const marksBySubject = {};
        latest.subjects.forEach(sub => { marksBySubject[sub.subject_name] = sub; });
        const dedupedSubjects = dedupeSubjectsForStream(allSubjects, streamBucket);
        const seenSubjectNames = new Set(dedupedSubjects.map(s => s.subject_name));
        const mergedSubjects = dedupedSubjects.map(subj => {
            const applicable = subj.applicable;
            const marks = applicable ? marksBySubject[subj.subject_name] : null;
            return { en: subj.subject_name, amh: null, s1: marks?.semester_1 ?? null, s2: marks?.semester_2 ?? null, applicable };
        });
        // Any subject with synced marks but no matching row in the
        // subjects master list still needs to show — it was clearly taught.
        latest.subjects.forEach(sub => {
            if (!seenSubjectNames.has(sub.subject_name)) {
                mergedSubjects.push({ en: sub.subject_name, amh: null, s1: sub.semester_1, s2: sub.semester_2, applicable: true });
            }
        });

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
            subjects: mergedSubjects,
            conduct: null, // no conduct-tracking feature yet — left blank on purpose, not fabricated
            absent_days_s1: s1 ? s1.days_absent : null,
            absent_days_s2: s2 ? s2.days_absent : null,
            rank: latest.rank,
            class_size: latest.class_size,
            verify_url: `${req.protocol}://${req.get('host')}/verify/${s.student_id}`
        });

        const browser = await getBrowser();
        const page = await browser.newPage();
        // The template's own <script> (certificate.js) does all the marks-
        // table/QR rendering client-side inside the page — if it throws,
        // Puppeteer does NOT surface that here by default, so the PDF just
        // comes out with a blank table and no error anywhere in our logs.
        // These two listeners make that failure visible.
        page.on('pageerror', err => console.error(`/api/student/certificate.pdf render error (student ${req.user.user_id}):`, err));
        page.on('console', msg => { if (msg.type() === 'error') console.error(`/api/student/certificate.pdf console error (student ${req.user.user_id}):`, msg.text()); });
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
// Also requires school_admins.title = 'Principal' on the actual principal's
// account — see requirePrincipal() above.

// Principal reviews who's currently at the top of the whole school
// (across every grade) before deciding whether to award recognition.
// Deliberately shows the top few, not just #1 — a genuine tie for first
// means more than one student may deserve it, and it's the Principal's
// call which (or how many) to actually award.
// Academic VP and Admin VP can view this leaderboard alongside the
// Principal (per the school's call that all three should be able to see
// who's leading) — but issuing the actual recognition award (POST
// /api/principal/recognition-awards below) stays the Principal's alone.
app.get('/api/principal/school-leaderboard', requireAuth, requireAdminTitle('Principal', 'Academic VP', 'Admin VP'), async (req, res) => {
    try {
        const leaderboard = await getSchoolYearLeaderboard(req.user.school_id);
        if (leaderboard.length === 0) {
            return res.json({ class_size: 0, leaders: [], top_female: null, ranked: [] });
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
            `SELECT student_id, first_name, middle_name, last_name, sex FROM students
             WHERE school_id = ? AND student_id IN (?)`,
            [req.user.school_id, leaderboard.map(l => l.student_id)]
        );
        const namesById = new Map(studentRows.map(s => [String(s.student_id), [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ')]));
        const sexById = new Map(studentRows.map(s => [String(s.student_id), s.sex]));

        const [alreadyAwarded] = await pool.query(
            `SELECT student_id FROM recognition_awards WHERE school_id = ? AND student_id IN (?)`,
            [req.user.school_id, leaderboard.map(l => l.student_id)]
        );
        const awardedSet = new Set(alreadyAwarded.map(r => String(r.student_id)));

        const ranked = leaderboard.map(l => ({
            ...l,
            full_name: namesById.get(String(l.student_id)) || null,
            sex: sexById.get(String(l.student_id)) || null,
            rank: ranks.get(String(l.student_id))?.rank ?? null,
            already_awarded: awardedSet.has(String(l.student_id))
        }));

        // Rank 1 by construction — kept as its own field since a genuine
        // tie means more than one student shares it, and that's who's
        // actually eligible for the award below, not just "whoever sorted first."
        const leaders = ranked.filter(l => l.rank === 1);

        // The single highest-scoring FEMALE student school-wide — a
        // separate recognition from "leaders" above, since the #1 overall
        // spot may already be held by a male student. Ties share it, same
        // competition-ranking rule as everywhere else (ranked is already
        // sorted by year_average descending).
        const topFemaleScore = ranked.find(l => l.sex === 'Female')?.year_average ?? null;
        const top_female = topFemaleScore == null ? [] : ranked.filter(l => l.sex === 'Female' && l.year_average === topFemaleScore);

        res.json({ class_size, leaders, top_female, ranked });
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

// Best-effort dimension read: some valid photos (certain WEBP/AVIF
// variants, some HEIC that didn't convert cleanly, oddly-encoded JPEGs
// from older phones/scanners, etc.) trip up the image-size library even
// though the file itself is a perfectly fine, displayable image. We only
// use dimensions to enforce a *minimum resolution* — a nice-to-have, not
// something worth blocking an upload over — so if we can't read them,
// skip that one check instead of rejecting the file. The mimetype check
// above already guarantees it's an image; the browser/ID-card renderer
// will display whatever comes through.
function tryReadImageDimensions(filePath) {
    try {
        return sizeOf(filePath);
    } catch {
        return null;
    }
}

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
            fs.unlink(req.file.path, () => { });
            return res.status(400).json({ error: "ID photo must be an image file (JPEG, PNG, GIF, or WEBP)." });
        }

        const converted = await convertHeicIfNeeded(req.file);
        if (converted) req.file = converted;

        const dimensions = tryReadImageDimensions(req.file.path);

        // Smaller side must clear the minimum, whichever axis it's on —
        // sidesteps EXIF-orientation issues entirely, since we're not
        // asserting which axis is "supposed" to be longer. Skipped
        // entirely if dimensions couldn't be read (see
        // tryReadImageDimensions above) — we'd rather accept an
        // unusually-encoded but valid photo than block the upload.
        if (dimensions) {
            const { width, height } = dimensions;
            const shortSide = Math.min(width, height);
            const longSide = Math.max(width, height);
            if (shortSide < ID_PHOTO_MIN_WIDTH || longSide < ID_PHOTO_MIN_HEIGHT) {
                fs.unlink(req.file.path, () => { });
                return res.status(400).json({
                    error: `ID photo is too small (yours was ${width}×${height}px). Please use a clearer, higher-resolution photo.`
                });
            }
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
            fs.unlink(oldPath, () => { }); // best-effort cleanup, don't fail the request over it
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
// hands it to school administration (Academic VP or similar school_admins
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
        if (req.file) fs.unlink(req.file.path, () => { });
        return res.status(400).json({ error: "date_from, date_to, and reason are all required." });
    }
    if (new Date(date_to) < new Date(date_from)) {
        if (req.file) fs.unlink(req.file.path, () => { });
        return res.status(400).json({ error: "date_to can't be before date_from." });
    }
    if (req.file && !req.file.mimetype.startsWith('image/') && req.file.mimetype !== 'application/pdf') {
        fs.unlink(req.file.path, () => { });
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
// Posting is restricted to school_admins only. Any school_admins account
// (Principal, Admin VP, or Academic VP) can post today, not specifically
// the Principal — swap requireRole('school_admins') for requirePrincipal
// below if you want to tighten this to Principal-only.
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

app.post('/api/announcements', requireAuth, requireRole('school_admins'), async (req, res) => {
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

app.delete('/api/announcements/:id', requireAuth, requireRole('school_admins'), async (req, res) => {
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
// school_admins can post/delete. Reuses the same `upload` multer instance
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

app.post('/api/gallery', requireAuth, requireRole('school_admins'), handleUploadError(upload.single('photo')), async (req, res) => {
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

// Sets the school's logo, shown in the nav header on every portal for that
// tenant (student/teacher/etc). Any school_admins account uploads it once,
// scoped to their own school_id, and every user at that school sees it
// from then on via /api/me's logo_url. zonal_admins/super_admins are
// intentionally excluded here — they're not tied to a single school_id,
// so this route as written (which always uses the logged-in account's
// own school_id) doesn't make sense for them. If a zonal/super admin
// needs to set a specific school's logo, that'll need its own route that
// takes a school_id as a parameter instead of assuming the caller's own.
app.post('/api/admin/school-logo', requireAuth, requireRole('school_admins'), handleUploadError(upload.single('logo')), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        if (!req.file.mimetype.startsWith('image/')) {
            return res.status(400).json({ error: "Logo must be an image file (JPEG, PNG, GIF, or WEBP)." });
        }

        const converted = await convertHeicIfNeeded(req.file);
        if (converted) req.file = converted;

        const filePath = `/uploads/${req.file.filename}`;
        await pool.query('UPDATE schools SET logo_url = ? WHERE id = ?', [filePath, req.user.school_id]);

        res.json({ logo_url: filePath });
    } catch (err) {
        console.error("POST /api/admin/school-logo error:", err);
        res.status(500).json({ error: "Could not upload school logo" });
    }
});

app.delete('/api/gallery/:id', requireAuth, requireRole('school_admins'), async (req, res) => {
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
        const accessCache = new Map(); // "subject_id|class_level|section|stream" -> boolean

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
            const rowLimits = ASSESSMENT_TYPE_LIMITS[type];
            if (score < rowLimits.min || score > rowLimits.max) {
                rowErrors.push(`Row ${i + 1}: ${assessmentTypeLabel(type)} score ${score} out of range (${rowLimits.min}-${rowLimits.max})`);
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

            // Check subject access (cached per subject+section combo) —
            // must be formally assigned to this subject+section, or have
            // an Academic-VP-approved subject_entry_request covering it.
            const accessKey = `${subject_id}|${studentInfo.class_level}|${studentInfo.section}|${studentInfo.stream}`;
            let allowed = accessCache.get(accessKey);
            if (allowed === undefined) {
                allowed = await hasSubjectAccess(req.user.user_id, req.user.school_id, subject_id, studentInfo.class_level, studentInfo.section, studentInfo.stream);
                accessCache.set(accessKey, allowed);
            }
            if (!allowed) {
                rowErrors.push(`Row ${i + 1}: you are not assigned to teach subject ${subject_id} for this student's section`);
                continue;
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

app.put('/api/update/:id', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
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

// Shared by both the eligibility preview (GET, below) and the actual
// decision (PUT, below) so they can never disagree with each other.
async function computePromotionEligibility(student_id, school_id, class_level) {
    const cutoff_mark = await getPassMarkCutoff(school_id);
    const leaderboard = await getSchoolYearLeaderboard(school_id);
    const entry = leaderboard.find(l => String(l.student_id) === String(student_id));
    const year_average = entry ? entry.year_average : null;
    let category;
    if (Number(class_level) >= 12) category = 'Graduating — see graduation workflow';
    else if (year_average === null) category = 'No marks on record yet';
    else category = year_average >= cutoff_mark ? 'Eligible for Promotion' : 'Detained/Retained';
    return { year_average, cutoff_mark, category };
}

app.get('/api/registrar/promotion-eligibility/:id', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT class_level FROM students WHERE student_id = ? AND school_id = ?', [req.params.id, req.user.school_id]);
        if (rows.length === 0) return res.status(404).json({ error: "Student not found in your school." });
        res.json(await computePromotionEligibility(req.params.id, req.user.school_id, rows[0].class_level));
    } catch (err) {
        console.error("/api/registrar/promotion-eligibility error:", err);
        res.status(500).json({ error: "Could not evaluate eligibility." });
    }
});

app.put('/api/promote/:id', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const { action, class_level, stream, override_reason } = req.body;
        if (action !== 'promote' && action !== 'retain') {
            return res.status(400).json({ error: "action must be 'promote' or 'retain'." });
        }

        const [studentRows] = await pool.query('SELECT class_level FROM students WHERE student_id = ? AND school_id = ?', [req.params.id, req.user.school_id]);
        if (studentRows.length === 0) return res.status(404).json({ error: "Student not found in your school." });
        const currentGrade = studentRows[0].class_level;

        const { year_average, cutoff_mark, category } = await computePromotionEligibility(req.params.id, req.user.school_id, currentGrade);
        const expectedAction = category === 'Eligible for Promotion' ? 'promote' : category === 'Detained/Retained' ? 'retain' : null;
        const was_override = !!expectedAction && expectedAction !== action;

        // Disagreeing with the cutoff's own recommendation requires a
        // written reason — enforced server-side too, not just in the UI,
        // since this is what actually gets written to the audit log.
        if (was_override && (!override_reason || !override_reason.trim())) {
            return res.status(400).json({ error: "This decision disagrees with the cut-off. An override reason is required." });
        }

        if (action === 'promote') {
            if (Number(currentGrade) >= 12) {
                return res.status(400).json({ error: "Grade 12 students are promoted via the graduation workflow, not this form." });
            }
            const newGrade = class_level ? Number(class_level) : Number(currentGrade) + 1;
            await pool.query(
                'UPDATE students SET class_level = ?, stream = ?, section = NULL WHERE student_id = ? AND school_id = ?',
                [newGrade, stream || 'General', req.params.id, req.user.school_id]
            );
        }
        // Retain: class_level/stream/section stay exactly as they are —
        // the student simply repeats the current grade.

        await pool.query(
            `INSERT INTO promotion_audit_log
                (student_id, school_id, action, from_class_level, to_class_level, year_average, cutoff_mark, was_override, override_reason, decided_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.params.id, req.user.school_id, action, currentGrade, action === 'promote' ? (class_level || Number(currentGrade) + 1) : currentGrade,
                year_average, cutoff_mark, was_override, override_reason || null, req.user.user_id]
        ).catch(err => console.error("promotion_audit_log insert failed (non-blocking):", err));

        res.json({
            message: action === 'promote'
                ? `Student promoted to Grade ${class_level || Number(currentGrade) + 1}${was_override ? ' (override)' : ''}.`
                : `Student retained in Grade ${currentGrade}${was_override ? ' (override)' : ''}.`
        });
    } catch (err) {
        console.error("/api/promote error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- Section Setup (Registrar only) ---

app.get('/api/registrar/sections', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, class_level, stream, section_name, max_capacity, is_active FROM class_sections WHERE school_id = ? ORDER BY class_level, stream, section_name',
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/registrar/sections GET error:", err);
        res.status(500).json({ error: "Could not load sections." });
    }
});

app.post('/api/registrar/sections', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const { class_level, stream, section_name, max_capacity } = req.body;
        if (!class_level || !stream || !section_name) {
            return res.status(400).json({ error: "Grade, stream, and section name are required." });
        }
        await pool.query(
            'INSERT INTO class_sections (school_id, class_level, stream, section_name, max_capacity, is_active) VALUES (?, ?, ?, ?, ?, TRUE)',
            [req.user.school_id, class_level, stream, section_name, max_capacity || null]
        );
        res.json({ message: "Section added." });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: "That section already exists for this grade and stream." });
        }
        console.error("/api/registrar/sections POST error:", err);
        res.status(500).json({ error: "Could not create section." });
    }
});

app.put('/api/registrar/sections/:id', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const { is_active, max_capacity } = req.body;
        const fields = [];
        const params = [];
        if (is_active !== undefined) { fields.push('is_active = ?'); params.push(!!is_active); }
        if (max_capacity !== undefined) { fields.push('max_capacity = ?'); params.push(max_capacity || null); }
        if (fields.length === 0) return res.status(400).json({ error: "Nothing to update." });
        params.push(req.params.id, req.user.school_id);
        const [result] = await pool.query(`UPDATE class_sections SET ${fields.join(', ')} WHERE id = ? AND school_id = ?`, params);
        if (result.affectedRows === 0) return res.status(404).json({ error: "Section not found." });
        res.json({ message: "Section updated." });
    } catch (err) {
        console.error("/api/registrar/sections PUT error:", err);
        res.status(500).json({ error: "Could not update section." });
    }
});

app.delete('/api/registrar/sections/:id', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        // Students already placed in this section are left exactly as they
        // are — deleting the section config only stops NEW placements into
        // it, same as deactivating, just permanent.
        const [result] = await pool.query('DELETE FROM class_sections WHERE id = ? AND school_id = ?', [req.params.id, req.user.school_id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: "Section not found." });
        res.json({ message: "Section deleted." });
    } catch (err) {
        console.error("/api/registrar/sections DELETE error:", err);
        res.status(500).json({ error: "Could not delete section." });
    }
});

// --- Automated Section Placement Wizard (Registrar only) ---

async function getUnassignedBuckets(school_id) {
    const [students] = await pool.query(
        `SELECT student_id, first_name, last_name, class_level, stream FROM students
         WHERE school_id = ? AND (section IS NULL OR section = '')`,
        [school_id]
    );
    const [activeSections] = await pool.query(
        'SELECT class_level, stream, COUNT(*) AS cnt FROM class_sections WHERE school_id = ? AND is_active = TRUE GROUP BY class_level, stream',
        [school_id]
    );
    const activeCountByKey = new Map(activeSections.map(s => [`${s.class_level}|${s.stream}`, s.cnt]));

    const byKey = new Map();
    for (const s of students) {
        const key = `${s.class_level}|${s.stream}`;
        if (!byKey.has(key)) byKey.set(key, { class_level: s.class_level, stream: s.stream, students: [] });
        byKey.get(key).students.push(s);
    }
    const buckets = [...byKey.values()].map(b => ({
        ...b,
        active_sections_configured: activeCountByKey.get(`${b.class_level}|${b.stream}`) || 0
    }));
    return { buckets, total_unassigned: students.length };
}

app.get('/api/registrar/unassigned-queue', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        res.json(await getUnassignedBuckets(req.user.school_id));
    } catch (err) {
        console.error("/api/registrar/unassigned-queue error:", err);
        res.status(500).json({ error: "Could not load the unassigned queue." });
    }
});

// The individual students behind the bucket counts above — "who's
// actually waiting", not just how many. Covers both brand-new
// registrations and students who just landed here via a completed
// transfer (both leave section NULL until placement runs).
app.get('/api/registrar/placement/registered', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name, sex, class_level, stream, status, created_at
             FROM students WHERE school_id = ? AND (section IS NULL OR section = '')
             ORDER BY created_at DESC`,
            [req.user.school_id]
        );
        res.json(rows.map(r => ({ ...r, full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') })));
    } catch (err) {
        console.error("/api/registrar/placement/registered error:", err);
        res.status(500).json({ error: "Could not load registered students." });
    }
});

// Students promoted into a new grade recently — shown alongside the
// unassigned queue on the Placement Wizard since a fresh batch of
// promotions is usually exactly why placement needs to run again.
// "Recent" = the last 90 days, not a hard cycle boundary, since there's
// no separate academic-year-cycle table to key off of here.
app.get('/api/registrar/placement/promoted', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT p.student_id, p.from_class_level, p.to_class_level, p.year_average, p.decided_at,
                    s.first_name, s.middle_name, s.last_name, s.sex, s.stream, s.section
             FROM promotion_audit_log p
             JOIN students s ON s.student_id = p.student_id AND s.school_id = p.school_id
             WHERE p.school_id = ? AND p.action = 'promote' AND p.decided_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
             ORDER BY p.decided_at DESC`,
            [req.user.school_id]
        );
        res.json(rows.map(r => ({ ...r, full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') })));
    } catch (err) {
        console.error("/api/registrar/placement/promoted error:", err);
        res.status(500).json({ error: "Could not load promoted students." });
    }
});

// --- Student Registry ("Students" nav) ---
// Every student ever enrolled at this school, each labeled with when
// they enrolled and — once they've left, however they left — when they
// left, both in E.C. (the frontend formats the raw datetimes here into
// "... E.C. (...)" via formatDateBilingual/formatYearBilingual, so this
// endpoint just needs to return honest timestamps). "Left" covers
// Graduated (graduated_at) and Transferred - Completed (the matching
// student_transfers.initiated_at) — anyone still Active/Pending has
// left_at = null. Recorders get read access too, same as Transfer Hub,
// since they're the ones doing day-to-day registration work.
app.get('/api/registrar/students', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
    try {
        const { status, class_level, q } = req.query;
        const params = [req.user.school_id];
        let where = 'WHERE s.school_id = ?';
        if (status) { where += ' AND s.status = ?'; params.push(status); }
        if (class_level) { where += ' AND s.class_level = ?'; params.push(class_level); }
        if (q && q.trim()) {
            where += ' AND (s.student_id LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ?)';
            const like = `%${q.trim()}%`;
            params.push(like, like, like);
        }

        const [rows] = await pool.query(
            `SELECT s.student_id, s.first_name, s.middle_name, s.last_name, s.sex, s.class_level, s.section, s.stream,
                    s.status, s.created_at, s.graduated_at,
                    (SELECT st.initiated_at FROM student_transfers st
                       WHERE st.from_school_id = s.school_id AND st.student_id = s.student_id
                       ORDER BY st.initiated_at DESC LIMIT 1) AS transfer_out_at
             FROM students s ${where}
             ORDER BY s.first_name, s.last_name`,
            params
        );

        const withLabels = rows.map(r => {
            let left_at = null;
            if (r.status === 'Graduated') left_at = r.graduated_at;
            else if (String(r.status || '').startsWith('Transferred')) left_at = r.transfer_out_at;
            return {
                student_id: r.student_id,
                full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '),
                sex: r.sex, class_level: r.class_level, section: r.section, stream: r.stream, status: r.status,
                enrolled_at: r.created_at,
                left_at
            };
        });
        res.json(withLabels);
    } catch (err) {
        console.error("/api/registrar/students error:", err);
        res.status(500).json({ error: "Could not load the student registry." });
    }
});

// Full cross-school history for one student — this is the same chain
// getStudentAcademicChain uses for the transfer-code preview, exposed
// directly so the Registrar can pull it up any time from the Students
// tab, not only mid-transfer.
app.get('/api/registrar/students/:student_id/history', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT student_id FROM students WHERE student_id = ? AND school_id = ?', [req.params.student_id, req.user.school_id]);
        if (rows.length === 0) return res.status(404).json({ error: "Student not found in your school." });

        const { chain, grade_summary } = await getStudentAcademicChain(req.user.school_id, req.params.student_id);
        res.json({ chain, grade_summary });
    } catch (err) {
        console.error("/api/registrar/students/:student_id/history error:", err);
        res.status(500).json({ error: "Could not load this student's history." });
    }
});

// Randomly and as evenly as possible distributes unassigned students
// across the active sections for a grade/stream. Body {} (no
// class_level/stream) runs it across every waiting bucket at once.
app.post('/api/registrar/trigger-placement', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const { class_level, stream } = req.body;
        const { buckets } = await getUnassignedBuckets(req.user.school_id);
        const targetBuckets = (class_level && stream)
            ? buckets.filter(b => String(b.class_level) === String(class_level) && b.stream === stream)
            : buckets;

        let placedTotal = 0;
        const shortfall = [];
        const skipped_buckets = [];

        for (const bucket of targetBuckets) {
            const [sections] = await pool.query(
                'SELECT id, section_name, max_capacity FROM class_sections WHERE school_id = ? AND class_level = ? AND stream = ? AND is_active = TRUE',
                [req.user.school_id, bucket.class_level, bucket.stream]
            );
            if (sections.length === 0) {
                skipped_buckets.push({ class_level: bucket.class_level, stream: bucket.stream });
                continue;
            }

            // Start each section's running count from its CURRENT occupancy
            // (not 0) so placement stays even across repeated runs, not
            // just within a single run.
            const [occRows] = await pool.query(
                `SELECT section, COUNT(*) AS cnt FROM students
                 WHERE school_id = ? AND class_level = ? AND stream = ? AND section IS NOT NULL
                 GROUP BY section`,
                [req.user.school_id, bucket.class_level, bucket.stream]
            );
            const occByName = new Map(occRows.map(r => [r.section, r.cnt]));
            const running = sections.map(s => ({ ...s, count: occByName.get(s.section_name) || 0 }));

            // Shuffle students so placement order isn't predictable/gameable.
            const shuffled = [...bucket.students].sort(() => Math.random() - 0.5);

            for (const student of shuffled) {
                const eligible = running.filter(s => !s.max_capacity || s.count < s.max_capacity);
                if (eligible.length === 0) {
                    shortfall.push(student.student_id);
                    continue;
                }
                const target = eligible.reduce((a, b) => a.count <= b.count ? a : b);
                await pool.query('UPDATE students SET section = ? WHERE student_id = ? AND school_id = ?', [target.section_name, student.student_id, req.user.school_id]);
                target.count++;
                placedTotal++;
            }
        }

        res.json({
            message: `${placedTotal} student(s) placed.`,
            shortfall,
            skipped_buckets
        });
    } catch (err) {
        console.error("/api/registrar/trigger-placement error:", err);
        res.status(500).json({ error: "Placement failed." });
    }
});

// --- Recorder Management (Registrar only) ---

const MAX_RECORDERS = 2;

app.get('/api/registrar/recorders', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [recorders] = await pool.query(
            `SELECT teacher_id, first_name, middle_name, last_name, recorder_assigned_by, recorder_assigned_at
             FROM teachers WHERE school_id = ? AND is_recorder = 1`,
            [req.user.school_id]
        );
        res.json({ recorders });
    } catch (err) {
        console.error("/api/registrar/recorders GET error:", err);
        res.status(500).json({ error: "Could not load recorders." });
    }
});

app.get('/api/registrar/eligible-recorders', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [teachers] = await pool.query(
            `SELECT teacher_id, first_name, middle_name, last_name FROM teachers
             WHERE school_id = ? AND is_recorder = 0`,
            [req.user.school_id]
        );
        res.json(teachers);
    } catch (err) {
        console.error("/api/registrar/eligible-recorders error:", err);
        res.status(500).json({ error: "Could not load eligible teachers." });
    }
});

app.post('/api/registrar/recorders', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const { teacher_id } = req.body;
        if (!teacher_id) return res.status(400).json({ error: "teacher_id is required." });

        const [[{ cnt }]] = await pool.query('SELECT COUNT(*) AS cnt FROM teachers WHERE school_id = ? AND is_recorder = 1', [req.user.school_id]);
        if (cnt >= MAX_RECORDERS) return res.status(400).json({ error: `Only ${MAX_RECORDERS} active Recorders are allowed at a time.` });

        const [result] = await pool.query(
            `UPDATE teachers SET is_recorder = 1, recorder_assigned_by = ?, recorder_assigned_at = NOW()
             WHERE teacher_id = ? AND school_id = ? AND is_recorder = 0`,
            [req.user.user_id, teacher_id, req.user.school_id]
        );
        if (result.affectedRows === 0) {
            const [exists] = await pool.query('SELECT teacher_id FROM teachers WHERE teacher_id = ? AND school_id = ?', [teacher_id, req.user.school_id]);
            if (exists.length === 0) return res.status(404).json({ error: "Teacher not found in your school." });
            return res.status(400).json({ error: "That teacher is already a Recorder." });
        }
        res.json({ message: "Teacher assigned as Recorder." });
    } catch (err) {
        console.error("/api/registrar/recorders POST error:", err);
        res.status(500).json({ error: "Could not assign Recorder." });
    }
});

app.delete('/api/registrar/recorders/:teacher_id', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [result] = await pool.query(
            `UPDATE teachers SET is_recorder = 0, recorder_assigned_by = NULL, recorder_assigned_at = NULL
             WHERE teacher_id = ? AND school_id = ? AND is_recorder = 1`,
            [req.params.teacher_id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "That teacher isn't a Recorder." });
        res.json({ message: "Recorder access removed." });
    } catch (err) {
        console.error("/api/registrar/recorders DELETE error:", err);
        res.status(500).json({ error: "Could not remove Recorder." });
    }
});

// --- Transfer Navigation Hub (Registrar AND Recorder — see spec: Recorders
// may manage incoming/outgoing transfer codes, just not sections/placement/
// promotion/recorder-mgmt) ---
//
// ADD THIS if it doesn't exist yet:
//   CREATE TABLE student_transfers (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     student_id VARCHAR(50) NOT NULL,          -- the ID at the SOURCE school
//     from_school_id INT NULL,                  -- NULL for external (non-network) transfers-in
//     to_school_id INT NULL,                    -- filled once completed
//     transfer_code VARCHAR(20) NULL UNIQUE,     -- NULL for external manual entries
//     status ENUM('pending','completed','cancelled') NOT NULL DEFAULT 'pending',
//     is_external BOOLEAN NOT NULL DEFAULT FALSE,
//     student_snapshot JSON NOT NULL,            -- captured record at time of transfer-out
//     new_student_id VARCHAR(50) NULL,           -- the ID assigned at the RECEIVING school, once completed
//     initiated_by VARCHAR(50) NOT NULL,
//     initiated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     completed_by VARCHAR(50) NULL,
//     completed_at DATETIME NULL
//   );

function generateTransferCode() {
    return 'TRF-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

// Same fields carried over on every path into this school (network
// transfer-in or external manual bypass) — kept in one place so both
// paths build the new record identically.
async function insertTransferredStudent(conn, school_id, fields) {
    const { school_name, school_prefix } = (await conn.query(
        'SELECT school_name, school_prefix FROM schools WHERE id = ? FOR UPDATE', [school_id]
    ))[0][0] || {};
    if (!school_prefix) throw new Error("Your school doesn't have a student ID prefix set yet. Contact an administrator.");

    const [[{ studentCount }]] = await conn.query('SELECT COUNT(*) as studentCount FROM students WHERE school_id = ?', [school_id]);
    const student_id = `${school_prefix}${String(studentCount + 1).padStart(5, '0')}`;
    const lms_username = student_id;
    const email_address = `${student_id}@${school_prefix.toLowerCase()}.edu`;
    const security_password = await bcrypt.hash('1234', 10);
    const assigned_pc = `PC-${Math.floor(Math.random() * 39) + 1}`;
    const status = (fields.fayda_number && fields.fayda_number.trim() !== '') ? 'Active' : 'Pending';

    // section is left NULL on purpose — transferred-in students wait for
    // the Placement Wizard exactly like new registrations do.
    await conn.query(
        `INSERT INTO students (student_id, school_id, school_name, first_name, middle_name, last_name, sex, class_level, stream, section, phone_number, fayda_number, status, lms_username, email_address, assigned_computer, security_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        [student_id, school_id, school_name, fields.first_name, fields.middle_name, fields.last_name, fields.sex,
            fields.class_level, fields.stream, fields.phone_number || null, fields.fayda_number || null, status,
            lms_username, email_address, assigned_pc, security_password]
    );
    return { student_id, assigned_pc };
}

// --- Student Academic History (spans schools, via the network-transfer
// chain in student_transfers) ---
// A network-transferred student gets a brand-new student_id at the
// receiving school (see insertTransferredStudent above) — their old
// grade 9/10/11 record doesn't just carry over. This walks
// student_transfers backwards from wherever the student sits today to
// find every earlier (school_id, student_id) they were known under, so
// the Registrar can see the FULL grade-by-grade record — not just what
// happened since this student's current ID was created. Stops walking
// back at the first hop that isn't a completed in-network transfer
// (i.e. their original enrollment, or an external/manual entry with no
// on-platform source record).
//
// Used by: GET /api/registrar/students/:student_id/history (current
// students), POST /api/registrar/transfers/incoming/lookup (preview,
// before a code is even completed), and the per-grade document
// availability check in the Documents tab.
async function getStudentAcademicChain(school_id, student_id) {
    const chain = [];
    let cur = { school_id, student_id };
    const seen = new Set();

    while (cur && !seen.has(`${cur.school_id}:${cur.student_id}`)) {
        seen.add(`${cur.school_id}:${cur.student_id}`);

        const [[schoolRow]] = await pool.query('SELECT school_name FROM schools WHERE id = ?', [cur.school_id]);
        const [[studentRow]] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name, class_level, status, created_at, graduated_at
             FROM students WHERE student_id = ? AND school_id = ?`,
            [cur.student_id, cur.school_id]
        );
        if (!studentRow) break; // record no longer exists at that school — stop here

        const [promotions] = await pool.query(
            `SELECT action, from_class_level, to_class_level, year_average, decided_at
             FROM promotion_audit_log WHERE student_id = ? AND school_id = ? ORDER BY decided_at ASC`,
            [cur.student_id, cur.school_id]
        );
        const [docs] = await pool.query(
            `SELECT doc_type, class_level, verify_code, issued_at
             FROM document_issuances WHERE student_id = ? AND school_id = ? ORDER BY issued_at ASC`,
            [cur.student_id, cur.school_id]
        );

        // The hop that brought this student INTO cur.school_id, if any —
        // tells us both how they arrived and (by recursing) where from.
        const [[incoming]] = await pool.query(
            `SELECT from_school_id, student_id AS source_student_id, is_external, completed_at
             FROM student_transfers WHERE to_school_id = ? AND new_student_id = ? AND status = 'completed'
             ORDER BY completed_at DESC LIMIT 1`,
            [cur.school_id, cur.student_id]
        );

        chain.unshift({
            school_id: cur.school_id,
            school_name: schoolRow ? schoolRow.school_name : null,
            student_id: studentRow.student_id,
            full_name: [studentRow.first_name, studentRow.middle_name, studentRow.last_name].filter(Boolean).join(' '),
            entered_at: incoming ? incoming.completed_at : studentRow.created_at,
            left_at: null, // filled in below once the chain is fully walked
            status: studentRow.status,
            graduated_at: studentRow.graduated_at,
            arrived_via: incoming ? (incoming.is_external ? 'external_transfer' : 'network_transfer') : 'original_enrollment',
            promotions,
            documents: docs
        });

        cur = (incoming && incoming.from_school_id) ? { school_id: incoming.from_school_id, student_id: incoming.source_student_id } : null;
    }

    // Stitch left_at: each stop's exit is the next stop's entry.
    for (let i = 0; i < chain.length - 1; i++) {
        chain[i].left_at = chain[i + 1].entered_at;
    }
    const last = chain[chain.length - 1];
    if (last) {
        if (last.status === 'Graduated') last.left_at = last.graduated_at;
        else if (String(last.status || '').startsWith('Transferred')) {
            const [[outgoing]] = await pool.query(
                `SELECT initiated_at FROM student_transfers WHERE from_school_id = ? AND student_id = ? ORDER BY initiated_at DESC LIMIT 1`,
                [last.school_id, last.student_id]
            );
            last.left_at = outgoing ? outgoing.initiated_at : null;
        }
    }

    // Merge into a flat per-grade (9-12) summary across the whole chain —
    // this is what answers "does this student already have a grade 9/10/
    // 11/12 record, and has a document already been issued for it".
    const grade_summary = [9, 10, 11, 12].map(class_level => {
        let has_academic_record = false;
        let promoted_entry = null;
        const documents = [];
        let school_name = null;
        for (const stop of chain) {
            const promo = stop.promotions.find(p => Number(p.from_class_level) === class_level || Number(p.to_class_level) === class_level);
            if (promo) { has_academic_record = true; promoted_entry = promo; school_name = stop.school_name; }
            stop.documents.filter(d => Number(d.class_level) === class_level).forEach(d => {
                documents.push({ ...d, school_name: stop.school_name });
                has_academic_record = true;
            });
        }
        return { class_level, has_academic_record, promotion: promoted_entry, documents, school_name };
    });

    return { chain, grade_summary };
}

// --- Outgoing ---

app.post('/api/registrar/transfers/outgoing', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { student_id } = req.body;
        if (!student_id) return res.status(400).json({ error: "student_id is required." });

        await conn.beginTransaction();
        const [rows] = await conn.query('SELECT * FROM students WHERE student_id = ? AND school_id = ? FOR UPDATE', [student_id, req.user.school_id]);
        if (rows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: "Student not found in your school." });
        }
        const student = rows[0];
        if (String(student.status || '').startsWith('Transferred')) {
            await conn.rollback();
            return res.status(400).json({ error: "This student already has a transfer in progress." });
        }

        // A Registrar can no longer start a transfer for a student who
        // hasn't gone through Student -> Principal (or Principal-direct)
        // approval first — this is the enforcement point for that rule.
        // FOR UPDATE so two simultaneous clears of the same request can't
        // both pass this check.
        const [approvedReq] = await conn.query(
            `SELECT request_id FROM student_transfer_requests WHERE student_id = ? AND school_id = ? AND status = 'approved' FOR UPDATE`,
            [student_id, req.user.school_id]
        );
        if (approvedReq.length === 0) {
            await conn.rollback();
            return res.status(403).json({ error: "This student does not have a Principal-approved transfer request on file." });
        }

        let code;
        for (let attempt = 0; attempt < 5; attempt++) {
            code = generateTransferCode();
            const [dupe] = await conn.query('SELECT id FROM student_transfers WHERE transfer_code = ?', [code]);
            if (dupe.length === 0) break;
            code = null;
        }
        if (!code) { await conn.rollback(); return res.status(500).json({ error: "Could not generate a unique transfer code — try again." }); }

        const snapshot = {
            first_name: student.first_name, middle_name: student.middle_name, last_name: student.last_name,
            sex: student.sex, class_level: student.class_level, stream: student.stream,
            phone_number: student.phone_number, fayda_number: student.fayda_number
        };

        await conn.query(
            `INSERT INTO student_transfers (student_id, from_school_id, transfer_code, status, is_external, student_snapshot, initiated_by)
             VALUES (?, ?, ?, 'pending', FALSE, ?, ?)`,
            [student_id, req.user.school_id, code, JSON.stringify(snapshot), req.user.user_id]
        );
        // students.status needs to be wide enough for the longest value
        // this app writes ('Transferred - Completed', 24 chars) — a
        // narrower VARCHAR/ENUM here causes MySQL strict mode to reject
        // this UPDATE with "Data truncated for column 'status'":
        //   ALTER TABLE students MODIFY COLUMN status VARCHAR(30) NOT NULL DEFAULT 'Active';
        await conn.query("UPDATE students SET status = 'Transferred - Pending' WHERE student_id = ? AND school_id = ?", [student_id, req.user.school_id]);

        // Clears the Principal-approved request checked above and links it
        // to the transfer just created — closing the Student -> Principal
        // -> Registrar loop.
        const [transferRow] = await conn.query('SELECT id FROM student_transfers WHERE transfer_code = ?', [code]);
        await conn.query(
            `UPDATE student_transfer_requests SET status = 'cleared', transfer_id = ?
             WHERE student_id = ? AND school_id = ? AND status = 'approved'`,
            [transferRow[0]?.id || null, student_id, req.user.school_id]
        );

        await conn.commit();
        res.json({ message: "Transfer code generated. Share it with the receiving school.", transfer_code: code });
    } catch (err) {
        await conn.rollback();
        console.error("/api/registrar/transfers/outgoing POST error:", err);
        res.status(500).json({ error: "Could not start the transfer." });
    } finally {
        conn.release();
    }
});

app.get('/api/registrar/transfer-requests/approved', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT tr.request_id, tr.student_id, tr.reason, tr.decided_at,
                    s.first_name, s.middle_name, s.last_name, s.sex, s.class_level, s.section
             FROM student_transfer_requests tr
             JOIN students s ON s.student_id = tr.student_id AND s.school_id = tr.school_id
             WHERE tr.school_id = ? AND tr.status = 'approved'
             ORDER BY tr.decided_at ASC`,
            [req.user.school_id]
        );
        res.json(rows.map(r => ({ ...r, full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') })));
    } catch (err) {
        console.error("/api/registrar/transfer-requests/approved GET error:", err);
        res.status(500).json({ error: "Could not load approved transfer requests." });
    }
});

app.get('/api/registrar/transfers/outgoing', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
    try {
        // student_transfer_requests.transfer_id only gets set at the moment
        // the Registrar clears a Principal-approved request (see the POST
        // handler above), so this join is exactly "did this transfer come
        // from a Principal-approved request, or did the Registrar start it
        // directly" — no separate flag needed on student_transfers itself.
        const [rows] = await pool.query(
            `SELECT st.id, st.student_id, st.transfer_code, st.status, st.to_school_id, st.new_student_id,
                    st.initiated_at, st.completed_at, tr.request_id AS principal_request_id
             FROM student_transfers st
             LEFT JOIN student_transfer_requests tr ON tr.transfer_id = st.id
             WHERE st.from_school_id = ? ORDER BY st.initiated_at DESC`,
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/registrar/transfers/outgoing GET error:", err);
        res.status(500).json({ error: "Could not load outgoing transfers." });
    }
});

app.post('/api/registrar/transfers/outgoing/:id/cancel', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM student_transfers WHERE id = ? AND from_school_id = ?', [req.params.id, req.user.school_id]);
        if (rows.length === 0) return res.status(404).json({ error: "Transfer not found." });
        if (rows[0].status !== 'pending') return res.status(400).json({ error: "Only a pending transfer can be cancelled." });

        const [studentRows] = await pool.query('SELECT fayda_number FROM students WHERE student_id = ? AND school_id = ?', [rows[0].student_id, req.user.school_id]);
        const restoredStatus = (studentRows[0]?.fayda_number && studentRows[0].fayda_number.trim() !== '') ? 'Active' : 'Pending';

        await pool.query("UPDATE student_transfers SET status = 'cancelled' WHERE id = ?", [req.params.id]);
        await pool.query('UPDATE students SET status = ? WHERE student_id = ? AND school_id = ?', [restoredStatus, rows[0].student_id, req.user.school_id]);

        res.json({ message: "Transfer cancelled — student restored to your active roster." });
    } catch (err) {
        console.error("/api/registrar/transfers/outgoing cancel error:", err);
        res.status(500).json({ error: "Could not cancel the transfer." });
    }
});

// --- Incoming ---

// Preview-only — does NOT commit anything, so the receiving Registrar/
// Recorder can see who they're about to import before accepting.
app.post('/api/registrar/transfers/incoming/lookup', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
    try {
        const { transfer_code } = req.body;
        if (!transfer_code) return res.status(400).json({ error: "transfer_code is required." });

        const [rows] = await pool.query('SELECT * FROM student_transfers WHERE transfer_code = ?', [transfer_code.trim().toUpperCase()]);
        if (rows.length === 0) return res.status(404).json({ error: "No transfer found for that code." });
        const t = rows[0];
        if (t.status !== 'pending') return res.status(400).json({ error: `This transfer is already ${t.status}.` });
        if (t.from_school_id === req.user.school_id) return res.status(400).json({ error: "This transfer originated from your own school." });

        // Since the source school is on this same platform, the receiving
        // Registrar can already see the student's grade-by-grade record
        // (and every document already issued for them) before even
        // accepting the code — walked via the same transfer chain used by
        // /api/registrar/students/:student_id/history.
        let history = null;
        try {
            history = await getStudentAcademicChain(t.from_school_id, t.student_id);
        } catch (histErr) {
            console.error("transfers/incoming/lookup: history lookup failed (non-blocking):", histErr);
        }

        res.json({
            transfer_code: t.transfer_code,
            snapshot: typeof t.student_snapshot === 'string' ? JSON.parse(t.student_snapshot) : t.student_snapshot,
            history
        });
    } catch (err) {
        console.error("/api/registrar/transfers/incoming/lookup error:", err);
        res.status(500).json({ error: "Could not look up that transfer code." });
    }
});

app.post('/api/registrar/transfers/incoming/complete', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { transfer_code } = req.body;
        if (!transfer_code) return res.status(400).json({ error: "transfer_code is required." });

        await conn.beginTransaction();
        const [rows] = await conn.query('SELECT * FROM student_transfers WHERE transfer_code = ? FOR UPDATE', [transfer_code.trim().toUpperCase()]);
        if (rows.length === 0) { await conn.rollback(); return res.status(404).json({ error: "No transfer found for that code." }); }
        const t = rows[0];
        if (t.status !== 'pending') { await conn.rollback(); return res.status(400).json({ error: `This transfer is already ${t.status}.` }); }
        if (t.from_school_id === req.user.school_id) { await conn.rollback(); return res.status(400).json({ error: "This transfer originated from your own school." }); }

        const snapshot = typeof t.student_snapshot === 'string' ? JSON.parse(t.student_snapshot) : t.student_snapshot;
        const { student_id, assigned_pc } = await insertTransferredStudent(conn, req.user.school_id, snapshot);

        await conn.query(
            `UPDATE student_transfers SET status = 'completed', to_school_id = ?, new_student_id = ?, completed_by = ?, completed_at = NOW() WHERE id = ?`,
            [req.user.school_id, student_id, req.user.user_id, t.id]
        );
        // The old record stays in the source school for audit purposes —
        // just relabeled so it reads as resolved, not still "pending".
        await conn.query("UPDATE students SET status = 'Transferred - Completed' WHERE student_id = ? AND school_id = ?", [t.student_id, t.from_school_id]);

        await conn.commit();
        res.json({ message: `Student imported. New ID: ${student_id} — Awaiting Placement | PC: ${assigned_pc}`, student_id });
    } catch (err) {
        await conn.rollback();
        console.error("/api/registrar/transfers/incoming/complete error:", err);
        res.status(500).json({ error: "Could not complete the transfer: " + err.message });
    } finally {
        conn.release();
    }
});

// External school transfer manual bypass ("Skip") — for students arriving
// from a school outside this network, where there's no transfer code to
// look up. Creates the student directly, same as a network transfer-in,
// just without a source record on this platform.
app.post('/api/registrar/transfers/incoming/manual', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { first_name, middle_name, last_name, sex, class_level, stream, phone_number, fayda_number } = req.body;
        if (!first_name || !last_name || !sex || !class_level || !stream) {
            return res.status(400).json({ error: "First name, last name, sex, grade, and stream are required." });
        }

        await conn.beginTransaction();
        const { student_id, assigned_pc } = await insertTransferredStudent(conn, req.user.school_id,
            { first_name, middle_name, last_name, sex, class_level, stream, phone_number, fayda_number });

        await conn.query(
            `INSERT INTO student_transfers (student_id, from_school_id, to_school_id, transfer_code, status, is_external, student_snapshot, new_student_id, initiated_by, completed_by, completed_at)
             VALUES (?, NULL, ?, NULL, 'completed', TRUE, ?, ?, ?, ?, NOW())`,
            [student_id, req.user.school_id, JSON.stringify({ first_name, middle_name, last_name, sex, class_level, stream, phone_number, fayda_number }),
                student_id, req.user.user_id, req.user.user_id]
        );

        await conn.commit();
        res.json({ message: `Student added via external transfer. ID: ${student_id} — Awaiting Placement | PC: ${assigned_pc}`, student_id });
    } catch (err) {
        await conn.rollback();
        console.error("/api/registrar/transfers/incoming/manual error:", err);
        res.status(500).json({ error: "Could not add this student: " + err.message });
    } finally {
        conn.release();
    }
});

app.get('/api/registrar/transfers/incoming', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT id, student_id, from_school_id, is_external, new_student_id, status, completed_at
             FROM student_transfers WHERE to_school_id = ? ORDER BY completed_at DESC`,
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/registrar/transfers/incoming GET error:", err);
        res.status(500).json({ error: "Could not load incoming transfers." });
    }
});

// --- Student-initiated Transfer Requests: Student -> Principal -> Registrar ---
// This is the gated front door onto the Transfer Navigation Hub above.
// A student asks their own Principal for a transfer; the Principal is the
// only one who can approve it; only once approved does it become
// something a Registrar/Recorder can actually clear. Clearing itself
// reuses the *existing* POST /api/registrar/transfers/outgoing endpoint
// unchanged (same transfer-code generation Registrars already use) — see
// the auto-link block inside that handler below, which closes this
// request out once its transfer_code is generated. This means no new
// Registrar-side screen is required for a Registrar to act; only the
// Student- and Principal-side surfaces are new.
//
// ADD THIS if it doesn't exist yet:
//   CREATE TABLE student_transfer_requests (
//     request_id INT AUTO_INCREMENT PRIMARY KEY,
//     school_id INT NOT NULL,
//     student_id VARCHAR(50) NOT NULL,
//     reason TEXT NULL,
//     status ENUM('pending','approved','rejected','cleared') NOT NULL DEFAULT 'pending',
//     requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     decided_by VARCHAR(50) NULL,
//     decided_at DATETIME NULL,
//     decline_reason VARCHAR(255) NULL,
//     transfer_id INT NULL,          -- set once a Registrar clears it (FK to student_transfers.id)
//     FOREIGN KEY (school_id) REFERENCES schools(id)
//   );

app.post('/api/student/transfer-request', requireAuth, async (req, res) => {
    if (req.user.role !== 'students') return res.status(403).json({ error: "Only a student can submit their own transfer request." });
    const { reason } = req.body;
    try {
        const [existing] = await pool.query(
            `SELECT request_id FROM student_transfer_requests WHERE student_id = ? AND school_id = ? AND status IN ('pending','approved')`,
            [req.user.user_id, req.user.school_id]
        );
        if (existing.length > 0) return res.status(409).json({ error: "You already have a transfer request in progress." });

        const [result] = await pool.query(
            `INSERT INTO student_transfer_requests (school_id, student_id, reason) VALUES (?, ?, ?)`,
            [req.user.school_id, req.user.user_id, reason || null]
        );
        res.json({ message: "Transfer request sent to your Principal.", request_id: result.insertId });
    } catch (err) {
        console.error("/api/student/transfer-request POST error:", err);
        res.status(500).json({ error: "Could not submit transfer request" });
    }
});

app.get('/api/student/transfer-request', requireAuth, async (req, res) => {
    if (req.user.role !== 'students') return res.status(403).json({ error: "Students only." });
    try {
        const [rows] = await pool.query(
            `SELECT request_id, reason, status, requested_at, decline_reason
             FROM student_transfer_requests WHERE student_id = ? AND school_id = ? ORDER BY requested_at DESC LIMIT 1`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(rows[0] || null);
    } catch (err) {
        console.error("/api/student/transfer-request GET error:", err);
        res.status(500).json({ error: "Could not load your transfer request" });
    }
});

app.get('/api/principal/transfer-requests', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT tr.request_id, tr.student_id, tr.reason, tr.status, tr.requested_at, tr.decline_reason,
                    s.first_name, s.middle_name, s.last_name, s.sex, s.class_level, s.section
             FROM student_transfer_requests tr
             JOIN students s ON s.student_id = tr.student_id AND s.school_id = tr.school_id
             WHERE tr.school_id = ?
             ORDER BY (tr.status = 'pending') DESC, tr.requested_at DESC`,
            [req.user.school_id]
        );
        res.json(rows.map(r => ({ ...r, full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') })));
    } catch (err) {
        console.error("/api/principal/transfer-requests GET error:", err);
        res.status(500).json({ error: "Could not load transfer requests" });
    }
});

app.post('/api/principal/transfer-requests/:id/approve', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [result] = await pool.query(
            `UPDATE student_transfer_requests SET status = 'approved', decided_by = ?, decided_at = NOW()
             WHERE request_id = ? AND school_id = ? AND status = 'pending'`,
            [req.user.user_id, req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Request not found or already decided." });
        res.json({ message: "Approved. Sent to the Registrar to clear and issue the transfer code." });
    } catch (err) {
        console.error("/api/principal/transfer-requests/:id/approve error:", err);
        res.status(500).json({ error: "Could not approve this request" });
    }
});

app.post('/api/principal/transfer-requests/:id/reject', requireAuth, requirePrincipal, async (req, res) => {
    const { reason } = req.body;
    try {
        const [result] = await pool.query(
            `UPDATE student_transfer_requests SET status = 'rejected', decline_reason = ?, decided_by = ?, decided_at = NOW()
             WHERE request_id = ? AND school_id = ? AND status = 'pending'`,
            [reason || null, req.user.user_id, req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Request not found or already decided." });
        res.json({ message: "Transfer request rejected." });
    } catch (err) {
        console.error("/api/principal/transfer-requests/:id/reject error:", err);
        res.status(500).json({ error: "Could not reject this request" });
    }
});

// Principal enters a student ID and transfers them out directly — no
// student-submitted request required first. Writes straight into
// student_transfer_requests with status 'approved' (as if it had already
// gone through the approve step), so it's immediately ready for the
// Registrar to clear and issue a transfer code, exactly like an
// approved student-initiated request.
app.post('/api/principal/transfer-requests/direct', requireAuth, requirePrincipal, async (req, res) => {
    const { student_id } = req.body;
    if (!student_id) return res.status(400).json({ error: "student_id is required" });
    try {
        const [studentRows] = await pool.query(
            'SELECT student_id, status FROM students WHERE student_id = ? AND school_id = ?',
            [student_id, req.user.school_id]
        );
        if (studentRows.length === 0) return res.status(404).json({ error: "Student not found in your school." });
        if (studentRows[0].status === 'Graduated' || String(studentRows[0].status || '').startsWith('Transferred')) {
            return res.status(409).json({ error: "This student has already graduated or transferred." });
        }

        const [existing] = await pool.query(
            `SELECT request_id FROM student_transfer_requests WHERE student_id = ? AND school_id = ? AND status IN ('pending','approved')`,
            [student_id, req.user.school_id]
        );
        if (existing.length > 0) return res.status(409).json({ error: "This student already has a transfer in progress." });

        const [result] = await pool.query(
            `INSERT INTO student_transfer_requests (school_id, student_id, reason, status, decided_by, decided_at)
             VALUES (?, ?, ?, 'approved', ?, NOW())`,
            [req.user.school_id, student_id, 'Initiated directly by Principal', req.user.user_id]
        );
        res.json({ message: "Transfer initiated. Sent to the Registrar to clear and issue a transfer code.", request_id: result.insertId });
    } catch (err) {
        console.error("/api/principal/transfer-requests/direct error:", err);
        res.status(500).json({ error: "Could not initiate transfer" });
    }
});

// Read-only for the Principal — this year's students who actually went
// through a completed-or-in-progress outgoing transfer at this school.
// A Registrar can no longer clear a transfer without an approved request
// on file (see the guard in POST /api/registrar/transfers/outgoing above),
// so every row here traces back to either a student-submitted request or
// a Principal-direct one.
app.get('/api/principal/transferred-students', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT s.student_id, s.first_name, s.middle_name, s.last_name, s.sex, s.class_level, s.section,
                    st.transfer_code, st.status AS transfer_status, st.initiated_at, st.completed_at
             FROM student_transfers st
             JOIN students s ON s.student_id = st.student_id AND s.school_id = st.from_school_id
             WHERE st.from_school_id = ? AND YEAR(st.initiated_at) = YEAR(CURDATE()) AND st.status != 'cancelled'
             ORDER BY st.initiated_at DESC`,
            [req.user.school_id]
        );
        res.json(rows.map(r => ({ ...r, full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') })));
    } catch (err) {
        console.error("/api/principal/transferred-students error:", err);
        res.status(500).json({ error: "Could not load transferred students" });
    }
});

// --- Graduation workflow (Registrar presses it; Principal is read-only) ---
// Referenced but not built until now (see the "Grade 12 students are
// promoted via the graduation workflow, not this form" note on
// PUT /api/promote/:id above). Registrar batches out this year's Grade 12
// students under a batch label (e.g. "2018 G12 Batch" — Ethiopian
// calendar, entered by the Registrar since that's a school calendar
// decision, not something to hardcode here). Principal only ever reads
// the result: who's in a batch and the male/female split.
// ADD THIS if it doesn't exist yet — history needs a per-student
// timestamp; graduation_batch alone (used by the Principal endpoints
// below) doesn't tell us *when*:
//   ALTER TABLE students ADD COLUMN graduated_at DATETIME NULL;
app.get('/api/registrar/graduation/eligible', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name, sex, class_level, section, stream
             FROM students WHERE school_id = ? AND CAST(class_level AS UNSIGNED) >= 12 AND status = 'Active'
             ORDER BY first_name, last_name`,
            [req.user.school_id]
        );
        const cutoff_mark = await getPassMarkCutoff(req.user.school_id);
        const leaderboard = await getSchoolYearLeaderboard(req.user.school_id);
        const withCategory = rows.map(r => {
            const entry = leaderboard.find(l => String(l.student_id) === String(r.student_id));
            const year_average = entry ? entry.year_average : null;
            const category = year_average === null ? 'No marks on record yet'
                : year_average >= cutoff_mark ? 'Eligible for Promotion' : 'Detained/Retained';
            return { ...r, full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '), year_average, category };
        });
        res.json(withCategory);
    } catch (err) {
        console.error("/api/registrar/graduation/eligible error:", err);
        res.status(500).json({ error: "Could not load graduation-eligible students" });
    }
});

app.post('/api/registrar/graduation/process', requireAuth, requireRegistrarOnly, async (req, res) => {
    const { student_ids, batch_tag, override_reason } = req.body;
    if (!batch_tag || !Array.isArray(student_ids) || student_ids.length === 0) {
        return res.status(400).json({ error: "batch_tag and at least one student_id are required" });
    }
    try {
        const [studentRows] = await pool.query(
            `SELECT student_id, class_level FROM students
             WHERE school_id = ? AND status = 'Active' AND student_id IN (?)`,
            [req.user.school_id, student_ids]
        );
        const cutoff_mark = await getPassMarkCutoff(req.user.school_id);
        const leaderboard = await getSchoolYearLeaderboard(req.user.school_id);

        // Same rule as regular promotion: below the cut-off needs a
        // written override reason, checked server-side too since this
        // is what actually gets committed.
        const toGraduate = [];
        const skipped = [];
        for (const s of studentRows) {
            const entry = leaderboard.find(l => String(l.student_id) === String(s.student_id));
            const year_average = entry ? entry.year_average : null;
            const eligible = year_average !== null && year_average >= cutoff_mark;
            if (!eligible && (!override_reason || !override_reason.trim())) {
                skipped.push({ student_id: s.student_id, reason: year_average === null ? "No marks on record yet" : "Below the pass-mark cut-off (override reason required)" });
                continue;
            }
            toGraduate.push(s.student_id);
        }

        let graduated = 0;
        if (toGraduate.length > 0) {
            const [result] = await pool.query(
                `UPDATE students SET status = 'Graduated', graduation_batch = ?, graduated_at = NOW()
                 WHERE school_id = ? AND status = 'Active' AND student_id IN (?)`,
                [batch_tag, req.user.school_id, toGraduate]
            );
            graduated = result.affectedRows;
        }

        res.json({
            message: `${graduated} student(s) graduated under "${batch_tag}".${skipped.length ? ` ${skipped.length} skipped.` : ''}`,
            graduated,
            skipped
        });
    } catch (err) {
        console.error("/api/registrar/graduation/process error:", err);
        res.status(500).json({ error: "Could not graduate this batch" });
    }
});

app.get('/api/registrar/graduation/history', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name, graduation_batch AS batch_tag, graduated_at
             FROM students WHERE school_id = ? AND status = 'Graduated'
             ORDER BY graduated_at DESC, first_name, last_name`,
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/registrar/graduation/history error:", err);
        res.status(500).json({ error: "Could not load graduation history" });
    }
});

app.get('/api/principal/graduation-batches', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT graduation_batch, COUNT(*) AS total,
                    SUM(CASE WHEN sex = 'Male' THEN 1 ELSE 0 END) AS male,
                    SUM(CASE WHEN sex = 'Female' THEN 1 ELSE 0 END) AS female
             FROM students WHERE school_id = ? AND graduation_batch IS NOT NULL
             GROUP BY graduation_batch ORDER BY graduation_batch DESC`,
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/principal/graduation-batches error:", err);
        res.status(500).json({ error: "Could not load graduation batches" });
    }
});

app.get('/api/principal/graduation-batches/:batch', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name, sex, class_level, section, stream
             FROM students WHERE school_id = ? AND graduation_batch = ? ORDER BY first_name, last_name`,
            [req.user.school_id, req.params.batch]
        );
        res.json(rows.map(r => ({ ...r, full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') })));
    } catch (err) {
        console.error("/api/principal/graduation-batches/:batch error:", err);
        res.status(500).json({ error: "Could not load this batch" });
    }
});

// --- Principal -> Registrar document requests, and the Registrar
// notification bell ---
// There wasn't previously a way for a Principal to ask the Registrar to
// issue a document for a student — this adds that, and a bell so the
// Registrar sees it (and approved-but-uncleared transfer requests, from
// the existing student_transfer_requests flow above) without having to
// go check every tab manually.
//
// ADD THIS if it doesn't exist yet:
//   CREATE TABLE principal_document_requests (
//     request_id INT AUTO_INCREMENT PRIMARY KEY,
//     school_id INT NOT NULL,
//     student_id VARCHAR(50) NOT NULL,
//     doc_type ENUM('report_card','transcript','id_card') NOT NULL,
//     note TEXT NULL,
//     status ENUM('pending','fulfilled','dismissed') NOT NULL DEFAULT 'pending',
//     requested_by VARCHAR(50) NOT NULL,
//     requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     handled_by VARCHAR(50) NULL,
//     handled_at DATETIME NULL
//   );

app.post('/api/principal/document-requests', requireAuth, requirePrincipal, async (req, res) => {
    const { student_id, doc_type, note } = req.body;
    if (!student_id || !['report_card', 'transcript', 'id_card'].includes(doc_type)) {
        return res.status(400).json({ error: "student_id and a valid doc_type are required" });
    }
    try {
        const [result] = await pool.query(
            `INSERT INTO principal_document_requests (school_id, student_id, doc_type, note, requested_by)
             VALUES (?, ?, ?, ?, ?)`,
            [req.user.school_id, student_id, doc_type, note || null, req.user.user_id]
        );
        res.json({ message: "Sent to the Registrar.", request_id: result.insertId });
    } catch (err) {
        console.error("/api/principal/document-requests POST error:", err);
        res.status(500).json({ error: "Could not send this request" });
    }
});

app.get('/api/principal/document-requests', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT request_id, student_id, doc_type, note, status, requested_at, handled_at
             FROM principal_document_requests WHERE school_id = ? AND requested_by = ?
             ORDER BY requested_at DESC`,
            [req.user.school_id, req.user.user_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/principal/document-requests GET error:", err);
        res.status(500).json({ error: "Could not load your document requests" });
    }
});

app.post('/api/registrar/document-requests/:id/handle', requireAuth, requireRegistrarOnly, async (req, res) => {
    const { status } = req.body; // 'fulfilled' or 'dismissed'
    if (!['fulfilled', 'dismissed'].includes(status)) return res.status(400).json({ error: "status must be 'fulfilled' or 'dismissed'" });
    try {
        const [result] = await pool.query(
            `UPDATE principal_document_requests SET status = ?, handled_by = ?, handled_at = NOW()
             WHERE request_id = ? AND school_id = ? AND status = 'pending'`,
            [status, req.user.user_id, req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Request not found or already handled." });
        res.json({ message: "Updated." });
    } catch (err) {
        console.error("/api/registrar/document-requests/:id/handle error:", err);
        res.status(500).json({ error: "Could not update this request" });
    }
});

// Merges both notification sources into one feed for the bell icon.
// Deliberately read-only and cheap (two small queries) so it's safe to
// poll every 60s the same way the teacher portal polls /api/notifications.
app.get('/api/registrar/notifications', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [docRequests] = await pool.query(
            `SELECT dr.request_id, dr.student_id, dr.doc_type, dr.note, dr.requested_at,
                    s.first_name, s.last_name
             FROM principal_document_requests dr
             LEFT JOIN students s ON s.student_id = dr.student_id AND s.school_id = dr.school_id
             WHERE dr.school_id = ? AND dr.status = 'pending'
             ORDER BY dr.requested_at DESC`,
            [req.user.school_id]
        );
        const [transferRequests] = await pool.query(
            `SELECT tr.request_id, tr.student_id, tr.decided_at,
                    s.first_name, s.last_name
             FROM student_transfer_requests tr
             LEFT JOIN students s ON s.student_id = tr.student_id AND s.school_id = tr.school_id
             WHERE tr.school_id = ? AND tr.status = 'approved'
             ORDER BY tr.decided_at DESC`,
            [req.user.school_id]
        );

        const labels = { report_card: 'Report Card', transcript: 'Transcript', id_card: 'ID Card' };
        const notifications = [
            ...docRequests.map(r => ({
                type: 'document_request',
                id: r.request_id,
                text: `Principal requested a ${labels[r.doc_type] || r.doc_type} for ${[r.first_name, r.last_name].filter(Boolean).join(' ') || r.student_id}`,
                student_id: r.student_id,
                at: r.requested_at
            })),
            ...transferRequests.map(r => ({
                type: 'transfer_request',
                id: r.request_id,
                text: `Transfer approved for ${[r.first_name, r.last_name].filter(Boolean).join(' ') || r.student_id} — ready to clear`,
                student_id: r.student_id,
                at: r.decided_at
            }))
        ].sort((a, b) => new Date(b.at) - new Date(a.at));

        res.json(notifications);
    } catch (err) {
        console.error("/api/registrar/notifications error:", err);
        res.status(500).json({ error: "Could not load notifications" });
    }
});

// Registrar Dashboard: landing-page stats. Kept to a handful of cheap
// aggregate queries (counts, not row dumps) since this loads on every
// visit to the tab.
app.get('/api/registrar/dashboard', requireAuth, requireRegistrarOrRecorder, async (req, res) => {
    try {
        const [[studentCounts]] = await pool.query(
            `SELECT COUNT(*) AS total_students,
                    SUM(CASE WHEN sex = 'Male' THEN 1 ELSE 0 END) AS male,
                    SUM(CASE WHEN sex = 'Female' THEN 1 ELSE 0 END) AS female,
                    SUM(CASE WHEN section IS NULL THEN 1 ELSE 0 END) AS unassigned_section
             FROM students WHERE school_id = ? AND status = 'Active'`,
            [req.user.school_id]
        );
        const [[transferCounts]] = await pool.query(
            `SELECT COUNT(*) AS total_transfers,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_transfers
             FROM student_transfers WHERE from_school_id = ? OR to_school_id = ?`,
            [req.user.school_id, req.user.school_id]
        );
        const [[recorderCounts]] = await pool.query(
            `SELECT COUNT(*) AS total_recorders FROM teachers WHERE school_id = ? AND is_recorder = 1`,
            [req.user.school_id]
        );

        res.json({
            total_students: studentCounts.total_students || 0,
            male: studentCounts.male || 0,
            female: studentCounts.female || 0,
            unassigned_section: studentCounts.unassigned_section || 0,
            total_transfers: transferCounts.total_transfers || 0,
            pending_transfers: transferCounts.pending_transfers || 0,
            total_recorders: recorderCounts.total_recorders || 0
        });
    } catch (err) {
        console.error("/api/registrar/dashboard error:", err);
        res.status(500).json({ error: "Could not load dashboard stats" });
    }
});
// Spec calls these out as two sidebar views (a template gallery, and a
// per-student issuance search) — implemented here as one set of
// endpoints: every generator below works either with a real student_id
// (Issuance Suite) or with the built-in SAMPLE_STUDENT placeholder
// (Template Hub's "preview the blank template" view), so the exact same
// tested rendering code produces both.
//
// ADD THIS if it doesn't exist yet:
//   CREATE TABLE document_issuances (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     student_id VARCHAR(50) NOT NULL,
//     school_id INT NOT NULL,
//     doc_type ENUM('report_card','transcript','id_card') NOT NULL,
//     verify_code VARCHAR(20) NOT NULL UNIQUE,
//     issued_by VARCHAR(50) NOT NULL,
//     issued_at DATETIME DEFAULT CURRENT_TIMESTAMP
//   );
//
// ADD THIS if it doesn't exist yet — lets the Documents tab show, per
// student, which grade (9/10/11/12) each past document actually covers,
// so the Registrar can see at a glance what's already been issued:
//   ALTER TABLE document_issuances ADD COLUMN class_level INT NULL;

const SAMPLE_STUDENT = {
    student_id: 'SAMPLE-0001',
    first_name: 'Sample', middle_name: 'A.', last_name: 'Student',
    sex: 'Female', class_level: 10, section: 'A', stream: 'General',
    phone_number: '0900000000', fayda_number: null, id_photo_url: null
};

function generateVerifyCode() {
    return crypto.randomBytes(6).toString('hex').toUpperCase();
}

async function logDocumentIssuance(school_id, student_id, doc_type, issued_by, class_level = null) {
    const code = generateVerifyCode();
    try {
        await pool.query(
            'INSERT INTO document_issuances (student_id, school_id, doc_type, verify_code, issued_by, class_level) VALUES (?, ?, ?, ?, ?, ?)',
            [student_id, school_id, doc_type, code, issued_by, class_level]
        );
    } catch (err) {
        console.error("logDocumentIssuance failed (non-blocking):", err);
    }
    return code;
}

// Same per-class-level subject/average/rank shape as
// /api/homeroom/student-report/:student_id, but callable by the
// Registrar for ANY student in their school (not just a homeroom
// teacher's own section) — kept as a separate function rather than
// reusing that route's handler so the homeroom-only access check there
// is never at risk of being loosened by a change made here.
async function computeReportCardData(student_id, school_id) {
    const [rows] = await pool.query(
        `SELECT s.subject_name, pr.class_level, pr.section, pr.stream, pr.term, prs.total_score
         FROM pushed_report_scores prs
         JOIN pushed_reports pr ON pr.push_id = prs.push_id AND pr.school_id = prs.school_id
         JOIN subjects s ON s.subject_id = pr.subject_id AND s.school_id = pr.school_id
         WHERE prs.student_id = ? AND prs.school_id = ?
         ORDER BY pr.class_level, s.subject_name, pr.term`,
        [student_id, school_id]
    );

    const byClassLevel = {};
    rows.forEach(row => {
        if (!byClassLevel[row.class_level]) byClassLevel[row.class_level] = { section: row.section, stream: row.stream, subjects: {} };
        const bucket = byClassLevel[row.class_level].subjects;
        if (!bucket[row.subject_name]) bucket[row.subject_name] = {};
        bucket[row.subject_name][row.term] = Number(row.total_score);
    });

    return Object.keys(byClassLevel).sort().map(class_level => {
        const { section, stream, subjects: subjectMap } = byClassLevel[class_level];
        const subjects = Object.keys(subjectMap).sort().map(subject_name => {
            const s1 = subjectMap[subject_name]['Semester 1'] ?? null;
            const s2 = subjectMap[subject_name]['Semester 2'] ?? null;
            return { subject_name, semester_1: s1, semester_2: s2, year_average: yearAverage(s1, s2) };
        });
        return {
            class_level, section, stream, subjects,
            semester_1_average: overallAverage(subjects.map(s => s.semester_1)),
            semester_2_average: overallAverage(subjects.map(s => s.semester_2)),
            year_average: overallAverage(subjects.map(s => s.year_average))
        };
    });
}

function renderReportCardHtml(student, reportData, verify_code) {
    const fullName = escapeHtml([student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' '));
    const issuedDate = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
    const ecYear = approximateEthiopianYear(new Date());

    const sections = reportData.length === 0
        ? '<p style="color:#7f8c8d;">No marks have been pushed for this student yet.</p>'
        : reportData.map(cl => `
            <h3>Grade ${cl.class_level} — Section ${cl.section} (${cl.stream})</h3>
            <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
                <thead>
                    <tr style="background:#2c3e50; color:white;">
                        <th style="padding:8px; text-align:left; border:1px solid #ddd;">Subject | ትምህርት</th>
                        <th style="padding:8px; border:1px solid #ddd;">Semester 1</th>
                        <th style="padding:8px; border:1px solid #ddd;">Semester 2</th>
                        <th style="padding:8px; border:1px solid #ddd;">Year Avg</th>
                    </tr>
                </thead>
                <tbody>
                    ${cl.subjects.map(s => `
                        <tr>
                            <td style="padding:8px; border:1px solid #ddd;">${escapeHtml(s.subject_name)}</td>
                            <td style="padding:8px; border:1px solid #ddd; text-align:center;">${s.semester_1 ?? '—'}</td>
                            <td style="padding:8px; border:1px solid #ddd; text-align:center;">${s.semester_2 ?? '—'}</td>
                            <td style="padding:8px; border:1px solid #ddd; text-align:center;">${s.year_average ?? '—'}</td>
                        </tr>
                    `).join('')}
                    <tr style="font-weight:bold; background:#f8f9fa;">
                        <td style="padding:8px; border:1px solid #ddd;">Overall Average</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${cl.semester_1_average ?? '—'}</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${cl.semester_2_average ?? '—'}</td>
                        <td style="padding:8px; border:1px solid #ddd; text-align:center;">${cl.year_average ?? '—'}</td>
                    </tr>
                </tbody>
            </table>
        `).join('');

    return `<!doctype html><html><head><meta charset="utf-8"><style>
        body { font-family: 'Segoe UI', Tahoma, sans-serif; padding: 40px; color: #2c3e50; }
        h1 { text-align:center; color:#1e3a8a; margin-bottom:0; }
        .sub { text-align:center; color:#666; margin-top:4px; }
        .footer { margin-top: 30px; font-size: 12px; color: #888; border-top: 1px solid #ddd; padding-top: 10px; }
    </style></head><body>
        <h1>${escapeHtml(student.school_name || 'School')}</h1>
        <p class="sub">Student Report Card | የተማሪ ውጤት ካርድ</p>
        <p><strong>Name | ስም:</strong> ${fullName} &nbsp;&nbsp; <strong>ID:</strong> ${escapeHtml(student.student_id)}</p>
        ${sections}
        <div class="footer">
            Issued ${issuedDate} (${ecYear} E.C.) by the Office of the Registrar.
            Verification code: ${verify_code} — verify at /verify/document/${verify_code}
        </div>
    </body></html>`;
}

// GET report-card data as JSON (drives the in-app preview pane before
// the Registrar commits to generating/printing the PDF).
app.get('/api/registrar/documents/report-card/:student_id', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const isSample = req.params.student_id === SAMPLE_STUDENT.student_id;
        let student;
        if (isSample) {
            student = { ...SAMPLE_STUDENT, school_name: 'Newland High School (Sample)' };
        } else {
            const [rows] = await pool.query('SELECT student_id, first_name, middle_name, last_name, school_name FROM students WHERE student_id = ? AND school_id = ?', [req.params.student_id, req.user.school_id]);
            if (rows.length === 0) return res.status(404).json({ error: "Student not found in your school." });
            student = rows[0];
        }
        const reportData = isSample
            ? [{ class_level: 10, section: 'A', stream: 'General', subjects: [{ subject_name: 'Sample Subject', semester_1: 88, semester_2: 91, year_average: 89.5 }], semester_1_average: 88, semester_2_average: 91, year_average: 89.5 }]
            : await computeReportCardData(req.params.student_id, req.user.school_id);
        res.json({ student, report: reportData });
    } catch (err) {
        console.error("/api/registrar/documents/report-card GET error:", err);
        res.status(500).json({ error: "Could not load report card data." });
    }
});

// Grade 9-12 record/document tracker for the Documents tab — before
// issuing a transcript, the Registrar can see which grades already have
// an academic record and which already had a document issued, including
// ones from a school this student transferred in from (see
// getStudentAcademicChain above). Also flags is_external so the UI can
// explain why a grade before the transfer might show no on-platform
// record (the source school isn't in this network).
app.get('/api/registrar/documents/history/:student_id', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT student_id FROM students WHERE student_id = ? AND school_id = ?', [req.params.student_id, req.user.school_id]);
        if (rows.length === 0) return res.status(404).json({ error: "Student not found in your school." });

        const { chain, grade_summary } = await getStudentAcademicChain(req.user.school_id, req.params.student_id);
        res.json({ chain, grade_summary });
    } catch (err) {
        console.error("/api/registrar/documents/history error:", err);
        res.status(500).json({ error: "Could not load this student's grade/document history." });
    }
});

// Report Card — a single grade/year's marks sheet, rendered from
// templates/certificate.html (that template's own title is "Student's
// Report Card"). Uses the latest COMPLETE year on file (both semesters
// synced), same "latest" logic the Transcript route used to use before
// the two were split apart — a report card for an in-progress year
// isn't ready to issue until both semesters exist.
// Used when a student has no marks history at all (buildYearSummaries
// has nothing to work with) — falls back to whatever class the student
// is CURRENTLY enrolled in, with every mark left null, so a document
// can still be generated instead of refusing outright just because
// nothing's been synced yet.
async function fallbackCurrentYearEntry(student_id, school_id) {
    const [rows] = await pool.query(
        `SELECT class_level, section, stream FROM students WHERE student_id = ? AND school_id = ?`,
        [student_id, school_id]
    );
    if (rows.length === 0) return null;
    const s = rows[0];
    return { class_level: s.class_level, section: s.section, stream: s.stream, subjects: [], year_average: null, rank: null, class_size: null, days_absent: 0 };
}

// Builds one real student's report card (html + verify_code). Never
// blocks on incomplete marks — a subject with no score yet just prints
// null/blank rather than the whole document being refused. Used by
// both the individual PDF route and the bulk combined-PDF route.
// Returns { ok:false, reason } only when the student genuinely can't
// be found, so bulk generation can skip that one and keep going.
async function buildReportCardForStudent(student_id, school_id, req) {
    const terms = await getCertificateTerms(student_id, school_id);
    let year_summary = await buildYearSummaries(student_id, school_id, terms);
    if (year_summary.length === 0) {
        const fallback = await fallbackCurrentYearEntry(student_id, school_id);
        if (!fallback) return { ok: false, reason: "student record not found" };
        year_summary = [fallback];
    }
    const latest = year_summary[year_summary.length - 1];
    const s1 = terms.find(t => t.class_level === latest.class_level && t.term === 'Semester 1');
    const s2 = terms.find(t => t.class_level === latest.class_level && t.term === 'Semester 2');

    const [studentRows] = await pool.query(
        `SELECT st.student_id, st.first_name, st.middle_name, st.last_name, st.sex, st.id_photo_url,
                sc.school_name, z.zone_name AS zone, w.woreda_name AS woreda, r.region_name AS region
         FROM students st
         LEFT JOIN schools sc ON sc.id = st.school_id
         LEFT JOIN zone z ON z.zone_id = sc.zone_id
         LEFT JOIN woreda w ON w.woreda_id = sc.woreda_id
         LEFT JOIN region r ON r.region_id = sc.region_id
         WHERE st.student_id = ? AND st.school_id = ?`,
        [student_id, school_id]
    );
    if (studentRows.length === 0) return { ok: false, reason: "student record not found" };
    const s = studentRows[0];

    const [homeroomRows] = await pool.query(
        `SELECT first_name, middle_name, last_name, signature_url FROM teachers WHERE school_id = ? AND homeroom_class_level = ? AND homeroom_section = ? AND homeroom_stream <=> ?`,
        [school_id, latest.class_level, latest.section, latest.stream]
    );
    const homeroomTeacherName = homeroomRows.length > 0
        ? [homeroomRows[0].first_name, homeroomRows[0].middle_name, homeroomRows[0].last_name].filter(Boolean).join(' ') : '';
    const homeroomSignatureHtml = buildSignatureHtml(homeroomRows[0]?.signature_url || null);

    // Principal's printed name + signature — same school_admins row the
    // student's own ID-card view already pulls signature_url/stamp_url
    // from (see /api/student/me). Null-safe: an unfilled Principal row,
    // or one with no signature uploaded yet, just leaves the line blank.
    const [principalRows] = await pool.query(
        `SELECT first_name, middle_name, last_name, signature_url, stamp_url FROM school_admins WHERE school_id = ? AND title = 'Principal' LIMIT 1`,
        [school_id]
    );
    const principalName = principalRows.length > 0
        ? [principalRows[0].first_name, principalRows[0].middle_name, principalRows[0].last_name].filter(Boolean).join(' ') : '';
    const principalSignatureHtml = buildSignatureHtml(principalRows[0]?.signature_url || null);
    const schoolSealHtml = buildSchoolSealHtml(principalRows[0]?.stamp_url || null);
    const principalStampWatermarkHtml = buildStampWatermarkHtml(principalRows[0]?.stamp_url || null);

    // Full sheet shows every subject the school teaches — not just the
    // ones with synced marks — so a subject outside this student's
    // stream still appears (struck through by certificate.js) rather
    // than silently disappearing from the page. subjects.stream is the
    // short 'Natural'/'Social'/'General'/NULL bucket set up in Subject
    // Configuration; students.stream is stored as the longer
    // 'Natural Science'/'Social Science' label, so match by substring
    // rather than exact equality.
    const [allSubjectsRaw] = await pool.query(
        `SELECT subject_name, stream FROM subjects WHERE school_id = ? ORDER BY subject_name`,
        [school_id]
    );
    const allSubjects = await filterToZoneDictionary(allSubjectsRaw, school_id);
    const streamBucket = /natural/i.test(latest.stream || '') ? 'Natural' : /social/i.test(latest.stream || '') ? 'Social' : 'General';
    const marksBySubject = {};
    latest.subjects.forEach(sub => { marksBySubject[sub.subject_name] = sub; });
    const dedupedSubjects = dedupeSubjectsForStream(allSubjects, streamBucket);
    const seenSubjectNames = new Set(dedupedSubjects.map(s => s.subject_name));
    const mergedSubjects = dedupedSubjects.map(subj => {
        const applicable = subj.applicable;
        const marks = applicable ? marksBySubject[subj.subject_name] : null;
        return { en: subj.subject_name, amh: null, s1: marks?.semester_1 ?? null, s2: marks?.semester_2 ?? null, applicable };
    });
    // Any subject with synced marks but no matching row in the subjects
    // master list (e.g. one added and later removed from Subject
    // Configuration) still needs to show — it clearly was taught.
    latest.subjects.forEach(sub => {
        if (!seenSubjectNames.has(sub.subject_name)) {
            mergedSubjects.push({ en: sub.subject_name, amh: null, s1: sub.semester_1, s2: sub.semester_2, applicable: true });
        }
    });

    const verify_code = await logDocumentIssuance(school_id, student_id, 'report_card', req.user.user_id, latest.class_level);
    const html = renderCertificateHtml({
        school_name: s.school_name, region: s.region, zone: s.zone, woreda: s.woreda, town: s.woreda,
        photo_html: buildPhotoHtml(s.id_photo_url), student_id: s.student_id,
        student_name: [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' '), sex: s.sex,
        grade: latest.class_level, section: latest.section, stream: latest.stream,
        academic_year: s2?.synced_at ? `${approximateEthiopianYear(s2.synced_at)} E.C.` : null,
        homeroom_teacher_name: homeroomTeacherName, homeroom_signature_html: homeroomSignatureHtml,
        principal_name: principalName, principal_signature_html: principalSignatureHtml,
        school_seal_html: schoolSealHtml, principal_stamp_watermark_html: principalStampWatermarkHtml,
        subjects: mergedSubjects,
        conduct: null, absent_days_s1: s1 ? s1.days_absent : null, absent_days_s2: s2 ? s2.days_absent : null,
        rank: latest.rank, class_size: latest.class_size,
        verify_url: `${req.protocol}://${req.get('host')}/verify/document/${verify_code}`
    });
    return { ok: true, html, verify_code, class_level: latest.class_level };
}

app.get('/api/registrar/documents/report-card/:student_id/pdf', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const isSample = req.params.student_id === SAMPLE_STUDENT.student_id;

        let html, verify_code;
        if (isSample) {
            verify_code = 'SAMPLE';
            html = renderCertificateHtml({
                school_name: 'Newland High School (Sample)', region: 'Sample Region', zone: 'Sample Zone', woreda: 'Sample Woreda', town: 'Sample Town',
                photo_html: buildPhotoHtml(null), student_id: SAMPLE_STUDENT.student_id,
                student_name: 'Sample Student', sex: 'Female', grade: 10, section: 'A', stream: 'General',
                academic_year: `${approximateEthiopianYear(new Date())} E.C.`,
                homeroom_teacher_name: 'Sample Teacher', homeroom_signature_html: '',
                principal_name: 'Sample Principal', principal_signature_html: '',
                subjects: [
                    { en: 'Sample Subject', amh: null, s1: 88, s2: 91, applicable: true },
                    { en: 'Sample Stream-Only Subject', amh: null, s1: null, s2: null, applicable: false }
                ],
                conduct: null, absent_days_s1: 0, absent_days_s2: 0, rank: 1, class_size: 30,
                verify_url: `${req.protocol}://${req.get('host')}/verify/document/SAMPLE`
            });
        } else {
            const result = await buildReportCardForStudent(req.params.student_id, req.user.school_id, req);
            if (!result.ok) return res.status(404).json({ error: "Student not found in your school." });
            html = result.html;
            verify_code = result.verify_code;
        }

        const browser = await getBrowser();
        const page = await browser.newPage();
        // See the matching comment on /api/student/certificate.pdf — without
        // these, a JS error inside the template's own script (certificate.js)
        // produces a silently blank marks table/QR with nothing in our logs.
        page.on('pageerror', err => console.error(`/api/registrar/documents/report-card render error (student ${req.params.student_id}):`, err));
        page.on('console', msg => { if (msg.type() === 'error') console.error(`/api/registrar/documents/report-card console error (student ${req.params.student_id}):`, msg.text()); });
        try {
            await page.setContent(html, { waitUntil: 'networkidle0' });
            const pdfBuffer = await page.pdf({ printBackground: true, preferCSSPageSize: true });
            res.setHeader('Content-Type', 'application/pdf');
            const disposition = isSample ? 'inline' : 'attachment';
            res.setHeader('Content-Disposition', `${disposition}; filename="ReportCard-${req.params.student_id}.pdf"`);
            res.send(pdfBuffer);
        } finally {
            await page.close();
        }
    } catch (err) {
        console.error("/api/registrar/documents/report-card/pdf error:", err);
        res.status(500).json({ error: "Could not generate the report card." });
    }
});

// Bulk Report Cards — every student in one grade/section/stream,
// combined into a single PDF (pdf-lib merges each student's page) so
// the whole section can be printed as one file. buildReportCardForStudent
// never blocks on incomplete marks now, so every student in the
// section is included — missing marks just print null on their page.
app.get('/api/registrar/documents/report-card/bulk/pdf', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const { class_level, section, stream } = req.query;
        if (!class_level || !section || !stream) {
            return res.status(400).json({ error: "Grade, section, and stream are required." });
        }
        const [students] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name FROM students
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ?
             ORDER BY first_name, last_name`,
            [req.user.school_id, class_level, section, stream]
        );
        if (students.length === 0) return res.status(404).json({ error: "No students found in that grade/section/stream." });

        const browser = await getBrowser();
        const merged = await PDFDocument.create();
        const skipped = [];

        for (const stu of students) {
            const result = await buildReportCardForStudent(stu.student_id, req.user.school_id, req);
            if (!result.ok) {
                skipped.push(`${[stu.first_name, stu.middle_name, stu.last_name].filter(Boolean).join(' ')} (${stu.student_id}) — ${result.reason}`);
                continue;
            }
            const page = await browser.newPage();
            try {
                await page.setContent(result.html, { waitUntil: 'networkidle0' });
                const pdfBytes = await page.pdf({ printBackground: true, preferCSSPageSize: true });
                const src = await PDFDocument.load(pdfBytes);
                const copiedPages = await merged.copyPages(src, src.getPageIndices());
                copiedPages.forEach((p) => merged.addPage(p));
            } finally {
                await page.close();
            }
        }

        if (merged.getPageCount() === 0) {
            return res.status(400).json({ error: "Could not generate report cards for any student in that section." });
        }

        if (skipped.length > 0) {
            const font = await merged.embedFont(StandardFonts.Helvetica);
            const notePage = merged.addPage();
            const { height } = notePage.getSize();
            notePage.drawText('Not included in this bulk export:', { x: 40, y: height - 60, size: 14, font });
            skipped.forEach((line, i) => {
                notePage.drawText(line.slice(0, 100), { x: 40, y: height - 90 - (i * 18), size: 10, font });
            });
        }

        const finalBytes = await merged.save();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="ReportCards-Grade${class_level}-${section}.pdf"`);
        res.send(Buffer.from(finalBytes));
    } catch (err) {
        console.error("/api/registrar/documents/report-card/bulk/pdf error:", err);
        if (!res.headersSent) res.status(500).json({ error: "Could not generate the bulk report cards." });
    }
});

// Official Transcript — the full Grade 9-12 academic record, rendered
// from templates/transcript.html (the four-year grid), as opposed to
// Report Card above which is one year's marks sheet from
// templates/certificate.html. Every COMPLETE year on file (both
// semesters synced) gets a column; an in-progress year is left off
// rather than shown half-filled. Each issuance is logged with its own
// verify code (see /verify/document/:code) as the audit trail.
app.get('/api/registrar/documents/transcript/:student_id/pdf', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const isSample = req.params.student_id === SAMPLE_STUDENT.student_id;

        let html, verify_code;
        if (isSample) {
            verify_code = 'SAMPLE';
            html = renderTranscriptHtml({
                student_id: SAMPLE_STUDENT.student_id, student_name: 'Sample Student', sex: 'Female', stream: 'General',
                age: '17', date_of_admission: '—', date_of_leaving: '—',
                registrar_name: [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || 'Registrar',
                issue_date: new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
                years: [
                    { class_level: 9, ec_year: String(approximateEthiopianYear(new Date()) - 3), subjects: [{ name: 'English', s1: 82, s2: 85, applicable: true }, { name: 'Mathematics', s1: 88, s2: 91, applicable: true }, { name: 'Physics', s1: null, s2: null, applicable: false }], total_s1: 170, total_s2: 176, avg_s1: 85, avg_s2: 88, avg_year: 86.5, days_absent_s1: 1, days_absent_s2: 0, rank: 4, class_size: 30 },
                    { class_level: 10, ec_year: String(approximateEthiopianYear(new Date()) - 2), subjects: [{ name: 'English', s1: 84, s2: 87, applicable: true }, { name: 'Mathematics', s1: 90, s2: 92, applicable: true }, { name: 'Physics', s1: null, s2: null, applicable: false }], total_s1: 174, total_s2: 179, avg_s1: 87, avg_s2: 89.5, avg_year: 88.25, days_absent_s1: 0, days_absent_s2: 1, rank: 3, class_size: 30 }
                ],
                verify_url: `${req.protocol}://${req.get('host')}/verify/document/SAMPLE`
            });
        } else {
            const terms = await getCertificateTerms(req.params.student_id, req.user.school_id);
            let year_summary = await buildYearSummaries(req.params.student_id, req.user.school_id, terms);
            if (year_summary.length === 0) {
                const fallback = await fallbackCurrentYearEntry(req.params.student_id, req.user.school_id);
                if (!fallback) return res.status(404).json({ error: "Student not found in your school." });
                year_summary = [fallback];
            }

            const [studentRows] = await pool.query(
                `SELECT student_id, first_name, middle_name, last_name, sex, created_at, status, graduated_at,
                        (SELECT st.initiated_at FROM student_transfers st
                           WHERE st.from_school_id = students.school_id AND st.student_id = students.student_id
                           ORDER BY st.initiated_at DESC LIMIT 1) AS transfer_out_at
                 FROM students WHERE student_id = ? AND school_id = ?`,
                [req.params.student_id, req.user.school_id]
            );
            if (studentRows.length === 0) return res.status(404).json({ error: "Student not found in your school." });
            const s = studentRows[0];
            let left_at = null;
            if (s.status === 'Graduated') left_at = s.graduated_at;
            else if (String(s.status || '').startsWith('Transferred')) left_at = s.transfer_out_at;

            const latest = year_summary[year_summary.length - 1];
            const years = year_summary.map(y => {
                const s1 = terms.find(t => t.class_level === y.class_level && t.term === 'Semester 1');
                const s2 = terms.find(t => t.class_level === y.class_level && t.term === 'Semester 2');
                return {
                    class_level: y.class_level,
                    ec_year: s2 && s2.synced_at ? String(approximateEthiopianYear(s2.synced_at)) : null,
                    subjects: y.subjects.map(sub => ({ name: sub.subject_name, s1: sub.semester_1, s2: sub.semester_2, applicable: sub.applicable })),
                    total_s1: s1 ? s1.term_total : null, total_s2: s2 ? s2.term_total : null,
                    avg_s1: s1 ? s1.term_average : null, avg_s2: s2 ? s2.term_average : null, avg_year: y.year_average,
                    days_absent_s1: s1 ? s1.days_absent : null, days_absent_s2: s2 ? s2.days_absent : null,
                    rank: y.rank, class_size: y.class_size
                };
            });

            verify_code = await logDocumentIssuance(req.user.school_id, req.params.student_id, 'transcript', req.user.user_id, latest.class_level);
            html = renderTranscriptHtml({
                student_id: s.student_id, student_name: [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' '),
                sex: s.sex, stream: latest.stream, age: null,
                date_of_admission: s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }) : null,
                date_of_leaving: left_at ? new Date(left_at).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }) : null,
                registrar_name: [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || null,
                issue_date: new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
                years,
                verify_url: `${req.protocol}://${req.get('host')}/verify/document/${verify_code}`
            });
        }

        const browser = await getBrowser();
        const page = await browser.newPage();
        page.on('pageerror', err => console.error(`/api/registrar/documents/transcript render error (student ${req.params.student_id}):`, err));
        page.on('console', msg => { if (msg.type() === 'error') console.error(`/api/registrar/documents/transcript console error (student ${req.params.student_id}):`, msg.text()); });
        try {
            await page.setContent(html, { waitUntil: 'networkidle0' });
            const pdfBuffer = await page.pdf({ printBackground: true, preferCSSPageSize: true });
            res.setHeader('Content-Type', 'application/pdf');
            const disposition = isSample ? 'inline' : 'attachment';
            res.setHeader('Content-Disposition', `${disposition}; filename="Transcript-${req.params.student_id}.pdf"`);
            res.send(pdfBuffer);
        } finally {
            await page.close();
        }
    } catch (err) {
        console.error("/api/registrar/documents/transcript/pdf error:", err);
        res.status(500).json({ error: "Could not generate the transcript." });
    }
});

// ID Card — same docx layout as the student self-service one
// (docxFieldRow etc.), just Registrar-callable for any student.
// Shared by the individual ID card download, the HTML preview, and the
// bulk zip below — one definition of the card layout (matching the
// student self-service /api/student/id-card.docx template) so none of
// them can drift apart from each other.
async function buildIdCardDocBuffer(s, isSample) {
    const full = [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ');
    const issued = s.created_at ? new Date(s.created_at) : new Date();
    const expires = new Date(issued);
    expires.setFullYear(expires.getFullYear() + 1);
    const fmt = d => d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });

    const fieldRows = [
        docxFieldRow('የተማሪ መታወቂያ | Student ID', s.student_id),
        docxFieldRow('ክፍል | Class', `Grade ${s.class_level} - ${s.section || 'Unassigned'}`),
        docxFieldRow('ትምህርት ዘርፍ | Stream', s.stream),
        docxFieldRow('ስልክ ቁጥር | Contact', s.phone_number || '—'),
    ];
    if (s.moe_school_code) fieldRows.push(docxFieldRow('የትምህርት ቤት ኮድ | School Code', s.moe_school_code));

    const children = [
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: (s.school_name || 'School').toUpperCase(), bold: true, size: 32, color: "1e3a8a" })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'የተማሪ መታወቂያ ካርድ | Student Identity Card', size: 18, color: "666666" })] }),
        new Paragraph({ text: "" }),
    ];
    if (!isSample && s.id_photo_url) {
        try {
            const photoPath = path.join(__dirname, 'uploads', path.basename(s.id_photo_url));
            const photoBuf = fs.readFileSync(photoPath);
            children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: photoBuf, transformation: { width: 100, height: 120 } })] }));
            children.push(new Paragraph({ text: "" }));
        } catch (photoErr) {
            console.error("buildIdCardDocBuffer: could not read photo file", photoErr);
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
    return Packer.toBuffer(doc);
}

// Fetches one student's id-card fields (or the sample) — shared by the
// docx route, the html preview route, and the bulk zip route below.
async function loadIdCardSubject(student_id, school_id) {
    const isSample = student_id === SAMPLE_STUDENT.student_id;
    if (isSample) {
        return { s: { ...SAMPLE_STUDENT, school_name: 'Newland High School (Sample)', created_at: new Date(), moe_school_code: 'SAMPLE-001' }, isSample };
    }
    const [rows] = await pool.query(
        `SELECT st.student_id, st.first_name, st.middle_name, st.last_name, st.class_level, st.section, st.stream,
                st.school_name, st.phone_number, st.created_at, st.id_photo_url, sc.moe_school_code
         FROM students st LEFT JOIN schools sc ON sc.id = st.school_id
         WHERE st.student_id = ? AND st.school_id = ?`,
        [student_id, school_id]
    );
    if (rows.length === 0) return { s: null, isSample };
    return { s: rows[0], isSample };
}

app.get('/api/registrar/documents/id-card/:student_id/docx', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const { s, isSample } = await loadIdCardSubject(req.params.student_id, req.user.school_id);
        if (!s) return res.status(404).json({ error: "Student not found in your school." });

        if (!isSample) await logDocumentIssuance(req.user.school_id, req.params.student_id, 'id_card', req.user.user_id, s.class_level);

        const buffer = await buildIdCardDocBuffer(s, isSample);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="ID-Card-${s.student_id}.docx"`);
        res.send(buffer);
    } catch (err) {
        console.error("/api/registrar/documents/id-card/docx error:", err);
        res.status(500).json({ error: "Could not generate ID card document." });
    }
});

// ID Card — HTML preview (view only: nothing downloaded, nothing
// logged as issued). Same student lookup and layout data as the .docx
// route above, just rendered as an inline styled page instead of a
// Word file, so it can sit inside an <iframe> in the Templates tab
// (or anywhere else a look-before-you-download makes sense).
app.get('/api/registrar/documents/id-card/:student_id/preview', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const { s, isSample } = await loadIdCardSubject(req.params.student_id, req.user.school_id);
        if (!s) return res.status(404).json({ error: "Student not found in your school." });

        const full = [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ');
        const issued = s.created_at ? new Date(s.created_at) : new Date();
        const expires = new Date(issued);
        expires.setFullYear(expires.getFullYear() + 1);
        const fmt = d => d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
        const photoHtml = isSample ? '<div class="photo">Student<br>Photo</div>' : buildPhotoHtml(s.id_photo_url);

        const html = `<!doctype html><html><head><meta charset="UTF-8">
<title>ID Card Preview — ${escapeHtml(full)}</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background:#f1f5f9; margin:0; padding:40px 20px; display:flex; justify-content:center; }
  .card { width:340px; background:#fff; border-radius:14px; box-shadow:0 10px 25px rgba(0,0,0,0.12); padding:24px; text-align:center; border-top:6px solid #1e3a8a; }
  .school { font-weight:800; font-size:1.05rem; color:#1e3a8a; letter-spacing:0.02em; }
  .subtitle { font-size:0.78rem; color:#666; margin-top:2px; margin-bottom:16px; }
  .photo { width:100px; height:120px; margin:0 auto 14px; background:#e2e8f0; color:#94a3b8; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:0.75rem; object-fit:cover; }
  .name { font-weight:700; font-size:1.1rem; color:#1e3a8a; margin-bottom:14px; }
  table { width:100%; border-collapse:collapse; text-align:left; font-size:0.85rem; margin-bottom:14px; }
  td { padding:5px 0; border-bottom:1px solid #f1f5f9; }
  td:first-child { color:#64748b; }
  td:last-child { text-align:right; font-weight:600; color:#1f2937; }
  .dates { font-size:0.78rem; color:#334155; text-align:left; }
  .dates .valid { font-weight:700; margin-top:2px; }
  .principal { font-size:0.78rem; color:#64748b; margin-top:14px; text-align:left; }
  ${isSample ? '.watermark { margin-top:16px; font-size:0.7rem; color:#94a3b8; text-transform:uppercase; letter-spacing:0.05em; }' : ''}
</style></head><body>
  <div class="card">
    <div class="school">${escapeHtml((s.school_name || 'School').toUpperCase())}</div>
    <div class="subtitle">የተማሪ መታወቂያ ካርድ | Student Identity Card</div>
    ${photoHtml}
    <div class="name">${escapeHtml(full)}</div>
    <table>
      <tr><td>Student ID</td><td>${escapeHtml(s.student_id)}</td></tr>
      <tr><td>Class</td><td>Grade ${escapeHtml(s.class_level)} - ${escapeHtml(s.section || 'Unassigned')}</td></tr>
      <tr><td>Stream</td><td>${escapeHtml(s.stream || '—')}</td></tr>
      <tr><td>Contact</td><td>${escapeHtml(s.phone_number || '—')}</td></tr>
      ${s.moe_school_code ? `<tr><td>School Code</td><td>${escapeHtml(s.moe_school_code)}</td></tr>` : ''}
    </table>
    <div class="dates">
      <div>Issued: ${fmt(issued)}</div>
      <div class="valid">Valid until: ${fmt(expires)}</div>
    </div>
    <div class="principal">Principal: _______________________</div>
    ${isSample ? '<div class="watermark">Sample layout — not a real ID card</div>' : ''}
  </div>
</body></html>`;
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (err) {
        console.error("/api/registrar/documents/id-card/preview error:", err);
        res.status(500).json({ error: "Could not render the ID card preview." });
    }
});

// Bulk ID Cards — every student in one grade/section/stream, zipped as
// individual .docx files. Uses buildIdCardDocBuffer above, so the
// layout is identical to a single student's download (which in turn
// matches the student self-service template). Each card is logged as
// issued, same as downloading one student's card individually would be.
app.get('/api/registrar/documents/id-card/bulk/docx-zip', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const { class_level, section, stream } = req.query;
        if (!class_level || !section || !stream) {
            return res.status(400).json({ error: "Grade, section, and stream are required." });
        }
        const [rows] = await pool.query(
            `SELECT st.student_id, st.first_name, st.middle_name, st.last_name, st.class_level, st.section, st.stream,
                    st.school_name, st.phone_number, st.created_at, st.id_photo_url, sc.moe_school_code
             FROM students st LEFT JOIN schools sc ON sc.id = st.school_id
             WHERE st.school_id = ? AND st.class_level = ? AND st.section = ? AND st.stream = ?
             ORDER BY st.first_name, st.last_name`,
            [req.user.school_id, class_level, section, stream]
        );
        if (rows.length === 0) return res.status(404).json({ error: "No students found in that grade/section/stream." });

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="ID-Cards-Grade${class_level}-${section}.zip"`);

        const archive = new ZipArchive({ zlib: { level: 9 } });
        archive.on('error', (err) => { console.error("bulk id-card zip stream error:", err); res.destroy(err); });
        archive.pipe(res);

        for (const s of rows) {
            const buffer = await buildIdCardDocBuffer(s, false);
            archive.append(buffer, { name: `ID-Card-${s.student_id}.docx` });
            await logDocumentIssuance(req.user.school_id, s.student_id, 'id_card', req.user.user_id, s.class_level);
        }
        await archive.finalize();
    } catch (err) {
        console.error("/api/registrar/documents/id-card/bulk/docx-zip error:", err);
        if (!res.headersSent) res.status(500).json({ error: "Could not generate the bulk ID cards." });
    }
});

// School Recommendation Letter — renders templates/recommendation.html.
// SAMPLE DATA ONLY for now: there's no per-student table yet to hold
// homeroom-teacher / parent comments or the principal's sign-off text,
// so a real student_id has nothing to pull from. Wiring this up for
// real students needs a comments-capture flow (likely a small new
// table + a UI for homeroom teachers to enter each semester's remark)
// before this can generate a real letter rather than the sample design.
app.get('/api/registrar/documents/recommendation/:student_id/preview', requireAuth, requireRegistrarOnly, async (req, res) => {
    if (req.params.student_id !== SAMPLE_STUDENT.student_id) {
        return res.status(501).json({ error: "School Recommendation Letters aren't wired to real student data yet — only the sample design preview is available today." });
    }
    try {
        const html = renderRecommendationHtml({
            school_name: 'Newland High School (Sample)', student_id: SAMPLE_STUDENT.student_id,
            student_name: 'Sample Student', grade: 10, section: 'A', academic_year: `${approximateEthiopianYear(new Date())} E.C.`,
            recommendation: {
                principal_name: [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || 'Principal',
                date: new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
                first_semester_comment: 'A conscientious student who participates actively in class and works well with peers.',
                first_semester_home_room_teacher: 'Sample Teacher',
                first_semester_parent_name: 'Sample Parent',
                second_semester_comment: 'Continued strong effort through the second semester, with noticeable improvement in written work.',
                second_semester_home_room_teacher: 'Sample Teacher',
                second_semester_parent_name: 'Sample Parent'
            },
            verify_url: `${req.protocol}://${req.get('host')}/verify/document/SAMPLE`
        });
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (err) {
        console.error("/api/registrar/documents/recommendation/preview error:", err);
        res.status(500).json({ error: "Could not render the recommendation letter preview." });
    }
});

app.get('/api/registrar/documents/issuance-log', requireAuth, requireRegistrarOnly, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, student_id, doc_type, verify_code, issued_by, issued_at FROM document_issuances WHERE school_id = ? ORDER BY issued_at DESC LIMIT 100',
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/registrar/documents/issuance-log error:", err);
        res.status(500).json({ error: "Could not load the issuance log." });
    }
});

// Public verification for any Registrar-issued document (report card,
// transcript, or ID card) — mirrors the existing /verify/:student_id
// pattern used for student self-service certificates, but keyed on the
// per-issuance code instead so each printed copy verifies independently.
app.get('/verify/document/:code', async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT di.doc_type, di.issued_at, st.first_name, st.middle_name, st.last_name, sc.school_name
             FROM document_issuances di
             JOIN students st ON st.student_id = di.student_id AND st.school_id = di.school_id
             LEFT JOIN schools sc ON sc.id = di.school_id
             WHERE di.verify_code = ?`,
            [req.params.code]
        );
        if (rows.length === 0) {
            return res.status(404).send('<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h2>Not found</h2><p>No document matches this verification code.</p></body></html>');
        }
        const d = rows[0];
        const fullName = escapeHtml([d.first_name, d.middle_name, d.last_name].filter(Boolean).join(' '));
        const docLabel = { report_card: 'Report Card', transcript: 'Official Transcript', id_card: 'Student ID Card' }[d.doc_type] || d.doc_type;
        res.send(
            '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:60px;">' +
            '<h2>&#10003; Document Verified</h2>' +
            `<p>This <strong>${escapeHtml(docLabel)}</strong> was issued by <strong>${escapeHtml(d.school_name || 'the school')}</strong> to <strong>${fullName}</strong> on ${new Date(d.issued_at).toLocaleDateString()}.</p>` +
            '</body></html>'
        );
    } catch (err) {
        console.error("/verify/document error:", err);
        res.status(500).send('Could not verify this document.');
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
            if (class_level) { sql += ' AND class_level = ?'; params.push(class_level); }
            if (section) { sql += ' AND section = ?'; params.push(section); }
            if (stream) { sql += ' AND stream = ?'; params.push(stream); }
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
            // A subject configured for "All Streams" (stream = NULL) always
            // qualifies too, on top of an exact match on the requested one.
            query += ' AND (stream = ? OR stream IS NULL)';
            params.push(stream);
        }

        const [rows] = await pool.query(query, params);
        res.json(rows);

    } catch (err) {
        console.error("Subject Query Error:", err);
        res.status(500).json({ error: "Could not fetch subjects" });
    }
});

// --- Subject Configuration (Academic VP) ---
// Not every school teaches every subject, and some subjects only apply to
// one stream (Natural vs Social) once a school splits Grade 11/12 that
// way. This is the write side that lets Academic VP register exactly
// which subjects this school teaches, and for which stream — General
// (Grade 9/10, or a subject good for either science stream), Natural, or
// Social. GET is the same data /api/subjects already serves (kept as its
// own admin-scoped route here since the Subject Configuration widget
// wants the full unfiltered list every time, not stream-scoped).
app.get('/api/academic-vp/subjects', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT subject_id, subject_name, stream FROM subjects WHERE school_id = ? ORDER BY subject_name',
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/academic-vp/subjects GET error:", err);
        res.status(500).json({ error: "Could not load subjects" });
    }
});

// The Subject Name dropdown in Subject Configuration is populated from
// THIS — the zone's own subject_dictionary (set by the Head of
// Education, see /api/zonal/subject-dictionary), not a hardcoded list.
// Academic VP can only ever pick a name their zone has actually
// defined; if their school's zone has nothing in the dictionary yet
// (or the school has no zone_id set at all), this returns an empty
// list rather than erroring, so the page still loads — the Add form
// just has nothing to offer until the zone sets one up.
app.get('/api/academic-vp/subject-dictionary', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    try {
        const zone_id = await getSchoolZoneId(req.user.school_id);
        if (!zone_id) return res.json([]);
        const [subjects] = await pool.query(
            'SELECT subject_name FROM subject_dictionary WHERE zone_id = ? ORDER BY subject_name',
            [zone_id]
        );
        res.json(subjects.map(s => s.subject_name));
    } catch (err) {
        console.error("/api/academic-vp/subject-dictionary GET error:", err);
        res.status(500).json({ error: "Could not load the subject dictionary" });
    }
});

app.post('/api/academic-vp/subjects', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { subject_name, stream } = req.body;
    if (!subject_name || !subject_name.trim()) return res.status(400).json({ error: "subject_name is required" });
    // Validated against the school's own zone dictionary — not a
    // hardcoded list — so Head of Education can add/retire subjects for
    // their zone (e.g. a mother-tongue subject specific to that zone)
    // without a code change, and a school can never configure a subject
    // its zone hasn't actually defined.
    const zone_id = await getSchoolZoneId(req.user.school_id);
    if (!zone_id) return res.status(400).json({ error: "Your school isn't assigned to a zone yet — contact your zonal admin." });
    const [[dictMatch]] = await pool.query(
        'SELECT subject_dict_id FROM subject_dictionary WHERE zone_id = ? AND subject_name = ?',
        [zone_id, subject_name.trim()]
    );
    if (!dictMatch) {
        return res.status(400).json({ error: "subject_name must be one of your zone's configured subjects." });
    }
    // "All Streams" (stream = null) is retired — a subject that's
    // actually taught in more than one stream (Math, English, IT, ...)
    // is added once per stream instead. The certificate/report-card/
    // transcript generation already merges same-named subjects down to
    // one row per student's own stream, so this doesn't bring back the
    // duplicate-subject-row bug.
    if (!stream || !['General', 'Natural', 'Social'].includes(stream)) {
        return res.status(400).json({ error: "stream is required and must be General, Natural, or Social." });
    }
    try {
        const [existing] = await pool.query(
            'SELECT subject_id FROM subjects WHERE school_id = ? AND subject_name = ? AND stream = ?',
            [req.user.school_id, subject_name.trim(), stream]
        );
        if (existing.length > 0) return res.status(409).json({ error: "This subject is already configured for that stream." });

        const [insertResult] = await pool.query(
            'INSERT INTO subjects (school_id, subject_name, stream) VALUES (?, ?, ?)',
            [req.user.school_id, subject_name.trim(), stream]
        );
        res.json({ message: "Subject added.", subject_id: insertResult.insertId });
    } catch (err) {
        console.error("/api/academic-vp/subjects POST error:", err);
        res.status(500).json({ error: "Could not add subject" });
    }
});

app.delete('/api/academic-vp/subjects/:subject_id', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    try {
        const [inUse] = await pool.query(
            'SELECT 1 FROM teacher_assignments WHERE subject_id = ? AND school_id = ? LIMIT 1',
            [req.params.subject_id, req.user.school_id]
        );
        if (inUse.length > 0) {
            return res.status(409).json({ error: "This subject is already assigned to a teacher — remove those assignments first." });
        }
        const [result] = await pool.query(
            'DELETE FROM subjects WHERE subject_id = ? AND school_id = ?',
            [req.params.subject_id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Subject not found." });
        res.json({ message: "Subject removed." });
    } catch (err) {
        // subject_id is also referenced from marks, mark_appeals,
        // class_timetable, pushed_reports, subject_entry_requests, and
        // textbook_distributions — none of those are pre-checked above (only
        // teacher_assignments is), so a subject that's already been used
        // anywhere in the system (timetabled, marked, requested, etc.) hits
        // a foreign-key constraint on delete. Surface that as a clear 409
        // instead of a bare, unexplained 500.
        if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED' || err.errno === 1451) {
            return res.status(409).json({ error: "This subject is still referenced elsewhere (marks, timetable, pushed reports, or a subject-entry request) and can't be removed. Consider deactivating it instead, or contact support to have those records cleared first." });
        }
        console.error("/api/academic-vp/subjects DELETE error:", err);
        res.status(500).json({ error: "Could not remove subject" });
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

// --- Teacher document approvals: signature + ID photo ---
// A homeroom teacher can upload a signature (used on report cards/
// certificates) and an ID photo (used on their staff ID card), but
// neither takes effect immediately — both go through the Principal for
// approval first, mirroring the same pending-request pattern used for
// student ID photo changes (id_photo_change_requests) above, just scoped
// to teachers and reviewed by the Principal specifically instead of a
// homeroom teacher.
//
// Requires a new table — run this migration if it doesn't exist yet:
//   CREATE TABLE teacher_document_requests (
//     request_id INT AUTO_INCREMENT PRIMARY KEY,
//     teacher_id VARCHAR(50) NOT NULL,
//     school_id INT NOT NULL,
//     doc_type ENUM('signature','id_photo','registrar_signature') NOT NULL,
//     requested_file_url VARCHAR(255) NOT NULL,
//     status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
//     rejection_reason VARCHAR(255) NULL,
//     reviewed_by VARCHAR(50) NULL,
//     reviewed_at DATETIME NULL,
//     requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     INDEX idx_teacher_doc (teacher_id, school_id, doc_type)
//   );
// Also requires these columns on teachers, which only get written once
// the Principal approves a request (never directly by the teacher):
//   ALTER TABLE teachers ADD COLUMN signature_url VARCHAR(255) NULL;
//   ALTER TABLE teachers ADD COLUMN id_photo_url VARCHAR(255) NULL;

async function submitTeacherDocumentRequest(req, res, docType, filePath) {
    // Replace any existing pending request of the same type rather than
    // piling up duplicates — same reasoning as the student ID photo flow.
    const [existingPending] = await pool.query(
        `SELECT request_id, requested_file_url FROM teacher_document_requests
         WHERE teacher_id = ? AND school_id = ? AND doc_type = ? AND status = 'pending'`,
        [req.user.user_id, req.user.school_id, docType]
    );

    if (existingPending.length > 0) {
        const oldPath = path.join(__dirname, 'uploads', path.basename(existingPending[0].requested_file_url));
        fs.unlink(oldPath, () => { }); // best-effort cleanup
        await pool.query(
            'UPDATE teacher_document_requests SET requested_file_url = ?, requested_at = NOW(), status = \'pending\', rejection_reason = NULL WHERE request_id = ?',
            [filePath, existingPending[0].request_id]
        );
    } else {
        await pool.query(
            `INSERT INTO teacher_document_requests (teacher_id, school_id, doc_type, requested_file_url, status)
             VALUES (?, ?, ?, ?, 'pending')`,
            [req.user.user_id, req.user.school_id, docType, filePath]
        );
    }

    res.json({ status: 'pending', doc_type: docType, requested_file_url: filePath });
}

app.post('/api/teacher/upload-signature', requireAuth, requireRole('teachers'), handleUploadError(upload.single('signature')), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        if (!req.file.mimetype.startsWith('image/')) {
            fs.unlink(req.file.path, () => { });
            return res.status(400).json({ error: "Signature must be an image file (JPEG or PNG)." });
        }
        const converted = await convertHeicIfNeeded(req.file);
        if (converted) req.file = converted;

        const filePath = `/uploads/${req.file.filename}`;
        await submitTeacherDocumentRequest(req, res, 'signature', filePath);
    } catch (err) {
        console.error("/api/teacher/upload-signature error:", err);
        res.status(500).json({ error: "Could not submit your signature for approval" });
    }
});

app.post('/api/teacher/upload-id-photo', requireAuth, requireRole('teachers'), handleUploadError(upload.single('photo')), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        if (!req.file.mimetype.startsWith('image/')) {
            fs.unlink(req.file.path, () => { });
            return res.status(400).json({ error: "ID photo must be an image file (JPEG, PNG, GIF, or WEBP)." });
        }
        const converted = await convertHeicIfNeeded(req.file);
        if (converted) req.file = converted;

        const dimensions = tryReadImageDimensions(req.file.path);
        if (dimensions) {
            const { width, height } = dimensions;
            const shortSide = Math.min(width, height);
            const longSide = Math.max(width, height);
            if (shortSide < ID_PHOTO_MIN_WIDTH || longSide < ID_PHOTO_MIN_HEIGHT) {
                fs.unlink(req.file.path, () => { });
                return res.status(400).json({
                    error: `ID photo is too small (yours was ${width}×${height}px). Please use a clearer, higher-resolution photo.`
                });
            }
        }

        const filePath = `/uploads/${req.file.filename}`;
        await submitTeacherDocumentRequest(req, res, 'id_photo', filePath);
    } catch (err) {
        console.error("/api/teacher/upload-id-photo error:", err);
        res.status(500).json({ error: "Could not submit your ID photo for approval" });
    }
});

// Returns the latest request (and its status) for both document types,
// plus whatever is currently the teacher's live approved signature/photo,
// so the profile page can show "pending", "approved", or "rejected" per
// document without two separate round trips.
// Registrar's own signature — deliberately separate from the homeroom
// teacher signature above (signature_url): a flag-granted Registrar is
// still a regular teacher underneath, but the two signatures go on
// different documents (homeroom report cards vs. registrar-issued
// transcripts/certificates) and can be different images. Also goes
// through the same Principal-approval pattern as signature/id_photo —
// see submitTeacherDocumentRequest above.
//
// ADD THESE if they don't exist yet:
//   ALTER TABLE teachers ADD COLUMN registrar_signature_url VARCHAR(255) NULL;
//   ALTER TABLE teacher_document_requests MODIFY doc_type ENUM('signature','id_photo','registrar_signature') NOT NULL;
app.post('/api/registrar/upload-signature', requireAuth, requireRegistrarOnly, handleUploadError(upload.single('signature')), async (req, res) => {
    if (req.user.role !== 'teachers') return res.status(400).json({ error: "Only a teacher-granted Registrar has a profile to attach a signature to." });
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        if (!req.file.mimetype.startsWith('image/')) {
            fs.unlink(req.file.path, () => { });
            return res.status(400).json({ error: "Signature must be an image file (JPEG or PNG)." });
        }
        const converted = await convertHeicIfNeeded(req.file);
        if (converted) req.file = converted;

        const filePath = `/uploads/${req.file.filename}`;
        await submitTeacherDocumentRequest(req, res, 'registrar_signature', filePath);
    } catch (err) {
        console.error("/api/registrar/upload-signature error:", err);
        res.status(500).json({ error: "Could not submit your signature for approval" });
    }
});

app.get('/api/teacher/document-status', requireAuth, requireRole('teachers'), async (req, res) => {
    try {
        const [live] = await pool.query(
            'SELECT signature_url, id_photo_url, registrar_signature_url FROM teachers WHERE teacher_id = ? AND school_id = ?',
            [req.user.user_id, req.user.school_id]
        );
        const [requests] = await pool.query(
            `SELECT request_id, doc_type, requested_file_url, status, rejection_reason, requested_at, reviewed_at
             FROM teacher_document_requests
             WHERE teacher_id = ? AND school_id = ?
             ORDER BY requested_at DESC`,
            [req.user.user_id, req.user.school_id]
        );

        const latestByType = {};
        for (const r of requests) {
            if (!latestByType[r.doc_type]) latestByType[r.doc_type] = r;
        }

        res.json({
            signature_url: live[0]?.signature_url || null,
            id_photo_url: live[0]?.id_photo_url || null,
            registrar_signature_url: live[0]?.registrar_signature_url || null,
            signature_request: latestByType.signature || { status: 'none' },
            id_photo_request: latestByType.id_photo || { status: 'none' },
            registrar_signature_request: latestByType.registrar_signature || { status: 'none' }
        });
    } catch (err) {
        console.error("/api/teacher/document-status error:", err);
        res.status(500).json({ error: "Could not load document approval status" });
    }
});

// --- Principal review: teacher signature / ID photo requests ---
app.get('/api/principal/teacher-document-requests', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT r.request_id, r.teacher_id, r.doc_type, r.requested_file_url, r.requested_at,
                    t.first_name, t.last_name
             FROM teacher_document_requests r
             JOIN teachers t ON t.teacher_id = r.teacher_id AND t.school_id = r.school_id
             WHERE r.school_id = ? AND r.status = 'pending'
             ORDER BY r.requested_at ASC`,
            [req.user.school_id]
        );
        res.json(rows.map(r => ({
            request_id: r.request_id,
            teacher_id: r.teacher_id,
            teacher_name: [r.first_name, r.last_name].filter(Boolean).join(' '),
            doc_type: r.doc_type,
            requested_file_url: r.requested_file_url,
            requested_at: r.requested_at
        })));
    } catch (err) {
        console.error("/api/principal/teacher-document-requests error:", err);
        res.status(500).json({ error: "Could not load pending requests" });
    }
});

app.post('/api/principal/teacher-document-requests/:id/approve', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT request_id, teacher_id, doc_type, requested_file_url FROM teacher_document_requests
             WHERE request_id = ? AND school_id = ? AND status = 'pending'`,
            [req.params.id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Request not found or already reviewed." });
        const request = rows[0];

        const column = request.doc_type === 'signature' ? 'signature_url' : request.doc_type === 'registrar_signature' ? 'registrar_signature_url' : 'id_photo_url';
        await pool.query(
            `UPDATE teachers SET ${column} = ? WHERE teacher_id = ? AND school_id = ?`,
            [request.requested_file_url, request.teacher_id, req.user.school_id]
        );
        await pool.query(
            `UPDATE teacher_document_requests SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE request_id = ?`,
            [req.user.user_id, request.request_id]
        );
        res.json({ message: "Approved." });
    } catch (err) {
        console.error("/api/principal/teacher-document-requests/:id/approve error:", err);
        res.status(500).json({ error: "Could not approve request" });
    }
});

app.post('/api/principal/teacher-document-requests/:id/reject', requireAuth, requirePrincipal, async (req, res) => {
    const { reason } = req.body;
    try {
        const [result] = await pool.query(
            `UPDATE teacher_document_requests
             SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW()
             WHERE request_id = ? AND school_id = ? AND status = 'pending'`,
            [reason || null, req.user.user_id, req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Request not found or already reviewed." });
        res.json({ message: "Rejected." });
    } catch (err) {
        console.error("/api/principal/teacher-document-requests/:id/reject error:", err);
        res.status(500).json({ error: "Could not reject request" });
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
    const { stream, class_level, section } = req.query;

    try {
        // This query:
        const sql = `
            SELECT DISTINCT s.subject_id, s.subject_name 
            FROM subjects s
            INNER JOIN teacher_assignments ta ON s.subject_id = ta.subject_id AND s.school_id = ta.school_id
            WHERE s.stream = ? AND ta.teacher_id = ? AND s.school_id = ?
        `;
        const [assignedRows] = await pool.query(sql, [stream, req.user.user_id, req.user.school_id]);

        // Also include any subject this teacher was specifically granted
        // temporary access to via an approved subject_entry_request for
        // this exact class_level+section+stream (see the homeroom
        // "request access to another subject" workflow above). Only
        // meaningful once the student search UI also sends class_level/
        // section — harmless (just contributes nothing) if it doesn't.
        let approvedRows = [];
        if (class_level && section) {
            [approvedRows] = await pool.query(
                `SELECT DISTINCT s.subject_id, s.subject_name
                 FROM subjects s
                 INNER JOIN subject_entry_requests r ON r.subject_id = s.subject_id AND r.school_id = s.school_id
                 WHERE r.teacher_id = ? AND r.school_id = ? AND r.status = 'approved'
                   AND r.class_level = ? AND r.section = ? AND r.stream = ?`,
                [req.user.user_id, req.user.school_id, class_level, section, stream]
            );
        }

        const combined = new Map();
        [...assignedRows, ...approvedRows].forEach(r => combined.set(r.subject_id, r));
        res.json([...combined.values()]);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch eligible subjects" });
    }
});
// Ensure these routes are in server.js
app.get('/api/teacher/full-profile', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT t.first_name, t.middle_name, t.last_name, t.teacher_id, t.contact_number, t.email, t.additional_role, t.avatar_url,
                    ta.stream, s.subject_name
             FROM teachers t
             LEFT JOIN teacher_assignments ta ON t.teacher_id = ta.teacher_id AND t.school_id = ta.school_id
             LEFT JOIN subjects s ON ta.subject_id = s.subject_id AND ta.school_id = s.school_id
             WHERE t.teacher_id = ? AND t.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Teacher not found" });
        res.json({
            first_name: rows[0].first_name,
            middle_name: rows[0].middle_name,
            last_name: rows[0].last_name,
            full_name: [rows[0].first_name, rows[0].middle_name, rows[0].last_name].filter(Boolean).join(' '),
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
            `SELECT t.first_name, t.middle_name, t.last_name, t.teacher_id, t.contact_number, t.email, t.avatar_url, t.id_photo_url, t.additional_role,
                    ta.stream, s.subject_name,
                    sc.school_name, z.zone_name AS zone, w.woreda_name AS woreda, r.region_name AS region, sc.moe_school_code
             FROM teachers t
             LEFT JOIN teacher_assignments ta ON t.teacher_id = ta.teacher_id AND t.school_id = ta.school_id
             LEFT JOIN subjects s ON ta.subject_id = s.subject_id AND ta.school_id = s.school_id
             LEFT JOIN schools sc ON sc.id = t.school_id
             LEFT JOIN zone z ON z.zone_id = sc.zone_id
             LEFT JOIN woreda w ON w.woreda_id = sc.woreda_id
             LEFT JOIN region r ON r.region_id = sc.region_id
             WHERE t.teacher_id = ? AND t.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Teacher not found" });

        const row0 = rows[0];
        const streams = [...new Set(rows.map(r => r.stream).filter(Boolean))];
        const subjects = [...new Set(rows.map(r => r.subject_name).filter(Boolean))];
        const schoolAddress = [row0.zone, row0.woreda, row0.region].filter(Boolean).join(', ') || null;

        // ID cards are valid for 2 years from the day they're issued/viewed.
        const validUntilDate = new Date();
        validUntilDate.setFullYear(validUntilDate.getFullYear() + 2);
        const validUntil = `${String(validUntilDate.getMonth() + 1).padStart(2, '0')}/${String(validUntilDate.getDate()).padStart(2, '0')}/${validUntilDate.getFullYear()}`;

        res.json({
            full_name: [row0.first_name, row0.middle_name, row0.last_name].filter(Boolean).join(' '),
            teacher_id: row0.teacher_id,
            contact_number: row0.contact_number,
            email: row0.email,
            // ID card photo comes from the Principal-approved id_photo_url,
            // not the everyday avatar_url (see teacher_document_requests
            // above) — falls back to avatar_url only if no ID photo has
            // been approved yet, so cards don't go blank in the meantime.
            avatar_url: row0.id_photo_url || row0.avatar_url || null,
            department: streams.length > 0 ? streams.join(', ') : (row0.additional_role || null),
            subjects,
            subject: subjects.length > 0 ? subjects.join(', ') : null,
            school_name: row0.school_name,
            school_address: schoolAddress,
            zone: row0.zone || null,
            woreda: row0.woreda || null,
            moe_school_code: row0.moe_school_code,
            valid_until: validUntil,
            qr_payload: signQrPayload(String(row0.teacher_id))
        });
    } catch (err) {
        console.error("/api/teacher/id-card error:", err);
        res.status(500).json({ error: "Could not load ID card data" });
    }
});

// Data for the school_admins "My ID Card" page — same shape/purpose as
// the teacher ID card above, just sourced from school_admins instead of
// teachers (no subject/stream/department — title stands in for role).
app.get('/api/admin/id-card', requireAuth, requireRole('school_admins'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT a.first_name, a.middle_name, a.last_name, a.admin_id, a.title, a.contact_number, a.email, a.avatar_url, a.id_photo_url,
                    sc.school_name, z.zone_name AS zone, w.woreda_name AS woreda, r.region_name AS region, sc.moe_school_code
             FROM school_admins a
             LEFT JOIN schools sc ON sc.id = a.school_id
             LEFT JOIN zone z ON z.zone_id = sc.zone_id
             LEFT JOIN woreda w ON w.woreda_id = sc.woreda_id
             LEFT JOIN region r ON r.region_id = sc.region_id
             WHERE a.admin_id = ? AND a.school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Admin not found" });

        const row0 = rows[0];
        const schoolAddress = [row0.zone, row0.woreda, row0.region].filter(Boolean).join(', ') || null;

        // Same 2-year validity convention as the teacher ID card.
        const validUntilDate = new Date();
        validUntilDate.setFullYear(validUntilDate.getFullYear() + 2);
        const validUntil = `${String(validUntilDate.getMonth() + 1).padStart(2, '0')}/${String(validUntilDate.getDate()).padStart(2, '0')}/${validUntilDate.getFullYear()}`;

        res.json({
            full_name: [row0.first_name, row0.middle_name, row0.last_name].filter(Boolean).join(' '),
            admin_id: row0.admin_id,
            title: row0.title,
            contact_number: row0.contact_number,
            email: row0.email,
            // ID card photo comes from id_photo_url specifically, not the
            // everyday avatar_url — falls back to avatar_url only for
            // admins who haven't uploaded a dedicated ID photo yet, so
            // existing cards don't suddenly go blank.
            avatar_url: row0.id_photo_url || row0.avatar_url || null,
            school_name: row0.school_name,
            school_address: schoolAddress,
            zone: row0.zone || null,
            woreda: row0.woreda || null,
            moe_school_code: row0.moe_school_code,
            valid_until: validUntil,
            qr_payload: signQrPayload(String(row0.admin_id))
        });
    } catch (err) {
        console.error("/api/admin/id-card error:", err);
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

        // Current-term Incomplete/Dropout flags the homeroom teacher has
        // set (see /api/homeroom/student-status below). Scoped to the
        // current term only — a student flagged Incomplete last semester
        // starts this semester's review clean.
        const currentTerm = await getCurrentTerm(req.user.school_id);
        const [statusRows] = await pool.query(
            `SELECT student_id, status, notified_at FROM student_term_status
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ?`,
            [req.user.school_id, class_level, section, stream, currentTerm]
        );
        const statusByStudent = {};
        statusRows.forEach(r => { statusByStudent[r.student_id] = { status: r.status, notified_at: r.notified_at }; });
        const [pushedNowRows] = await pool.query(
            'SELECT 1 FROM pushed_marks_reports WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ?',
            [req.user.school_id, class_level, section, stream, currentTerm]
        );
        const currentTermLocked = pushedNowRows.length > 0;

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
            const statusEntry = statusByStudent[student.student_id];
            return {
                student_id: student.student_id,
                full_name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' '),
                subjects,
                semester_1_average: overallAverage(subjectValues.map(s => s.semester_1)),
                semester_2_average: overallAverage(subjectValues.map(s => s.semester_2)),
                year_average: overallAverage(subjectValues.map(s => s.year_average)),
                // Reflects THIS term's review status only (see currentTerm
                // above) — 'Active' unless the homeroom teacher has
                // flagged the student Incomplete or Dropout for it.
                status: statusEntry?.status || 'Active',
                status_notified_at: statusEntry?.notified_at || null
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
            current_term: currentTerm,
            // Once this term's report has been pushed to the Academic VP,
            // Incomplete/Dropout flags for it are locked — same rule as
            // subject marks (see /api/homeroom/student-status).
            current_term_locked: currentTermLocked,
            students: report
        });
    } catch (err) {
        console.error("section-report error:", err);
        res.status(500).json({ error: "Could not load section report" });
    }
});

// --- Homeroom teacher: flag a student's status for the CURRENT term's
// master-sheet review ---
// status is one of 'Active' (default/clear), 'Incomplete' (missing one
// or more required assessments — surfaced to the student as a
// notification via /api/homeroom/notify-incomplete below and shown to
// the Academic VP once pushed), or 'Dropout' (student has stopped
// attending; no notification is sent for this one). Flags are scoped to
// class_level/section/stream/term via student_term_status, so a status
// set this semester doesn't carry over to the next.
//
// Requires a new table — run this migration if it doesn't exist yet:
//   CREATE TABLE student_term_status (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     school_id INT NOT NULL,
//     student_id VARCHAR(50) NOT NULL,
//     class_level VARCHAR(10) NOT NULL,
//     section VARCHAR(5) NOT NULL,
//     stream VARCHAR(30) NOT NULL,
//     term VARCHAR(20) NOT NULL,
//     status VARCHAR(20) NOT NULL DEFAULT 'Active',
//     flagged_by VARCHAR(50) NULL,
//     flagged_at DATETIME NULL,
//     notified_at DATETIME NULL,
//     UNIQUE KEY uq_student_term (school_id, student_id, term)
//   );
const STUDENT_TERM_STATUSES = ['Active', 'Incomplete', 'Dropout'];

app.post('/api/homeroom/student-status', requireAuth, async (req, res) => {
    const { student_id, status } = req.body;
    if (!student_id || !STUDENT_TERM_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${STUDENT_TERM_STATUSES.join(', ')}` });
    }

    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }
        const { class_level, section, stream } = homeroom;
        const term = await getCurrentTerm(req.user.school_id);

        // Same "locked once pushed" rule the marks themselves follow —
        // once the section's report is with the Academic VP, the roster
        // reviewed there shouldn't keep shifting underneath them.
        const [existingPush] = await pool.query(
            'SELECT 1 FROM pushed_marks_reports WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ?',
            [req.user.school_id, class_level, section, stream, term]
        );
        if (existingPush.length > 0) {
            return res.status(409).json({ error: `This section's ${term} report has already been pushed to the Academic VP and is locked.` });
        }

        const [studentRows] = await pool.query(
            'SELECT student_id FROM students WHERE student_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?',
            [student_id, class_level, section, stream, req.user.school_id]
        );
        if (studentRows.length === 0) {
            return res.status(404).json({ error: "This student isn't in your homeroom section." });
        }

        await pool.query(
            `INSERT INTO student_term_status (school_id, student_id, class_level, section, stream, term, status, flagged_by, flagged_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE status = VALUES(status), flagged_by = VALUES(flagged_by), flagged_at = NOW(),
                 notified_at = IF(VALUES(status) = 'Incomplete', notified_at, NULL)`,
            [req.user.school_id, student_id, class_level, section, stream, term, status, req.user.user_id]
        );

        res.json({ message: `Student marked ${status} for ${term}.` });
    } catch (err) {
        console.error("/api/homeroom/student-status error:", err);
        res.status(500).json({ error: "Could not update this student's status." });
    }
});

// --- Homeroom teacher: notify every student currently flagged
// Incomplete for the current term, once (skips anyone already notified
// so re-clicking after flagging a couple more students doesn't spam the
// whole list again). ---
app.post('/api/homeroom/notify-incomplete', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }
        const { class_level, section, stream } = homeroom;
        const term = await getCurrentTerm(req.user.school_id);

        const [rows] = await pool.query(
            `SELECT student_id FROM student_term_status
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ?
               AND status = 'Incomplete' AND notified_at IS NULL`,
            [req.user.school_id, class_level, section, stream, term]
        );

        if (rows.length === 0) {
            return res.json({ message: "No newly-flagged Incomplete students to notify.", notified: 0 });
        }

        const message = `You have been marked Incomplete for ${term}. One or more required assessments are still missing — please contact your subject teacher(s) and your homeroom teacher as soon as possible.`;
        for (const row of rows) {
            await notifyStudent(row.student_id, req.user.school_id, req.user.user_id, 'incomplete_status', message);
        }
        await pool.query(
            `UPDATE student_term_status SET notified_at = NOW()
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ? AND status = 'Incomplete' AND notified_at IS NULL`,
            [req.user.school_id, class_level, section, stream, term]
        );

        res.json({ message: `Notified ${rows.length} student(s) marked Incomplete.`, notified: rows.length });
    } catch (err) {
        console.error("/api/homeroom/notify-incomplete error:", err);
        res.status(500).json({ error: "Could not send notifications." });
    }
});

// Homeroom teacher's view of who's leading their own section — same
// ranking math as /api/homeroom/section-report (and ultimately the same
// rankStudents()/getSection*Averages() helpers the Principal's school-wide
// leaderboard uses), just trimmed down to name + average + rank rather
// than the full per-subject breakdown that page needs.
app.get('/api/homeroom/leaderboard', requireAuth, async (req, res) => {
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }
        const { class_level, section, stream } = homeroom;
        const currentTerm = await getCurrentTerm(req.user.school_id);

        const [syncRows] = await pool.query(
            `SELECT term FROM pushed_marks_reports
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term IN (?, ?)`,
            [req.user.school_id, class_level, section, stream, ...TERMS]
        );
        const syncedTerms = new Set(syncRows.map(r => r.term));
        const termSynced = syncedTerms.has(currentTerm);
        const yearAvailable = syncedTerms.has('Semester 1') && syncedTerms.has('Semester 2');

        // Prefer the year average once both semesters are in (the most
        // complete picture of who's actually leading); otherwise fall back
        // to whichever term is currently synced. If neither is synced yet,
        // there's nothing ranked to show.
        let entries, basis;
        if (yearAvailable) {
            entries = await getSectionYearAverages(req.user.school_id, class_level, section, stream);
            basis = 'year';
        } else if (termSynced) {
            entries = await getSectionTermAverages(req.user.school_id, class_level, section, stream, currentTerm);
            basis = 'term';
        } else {
            entries = [];
            basis = null;
        }

        if (entries.length === 0) {
            return res.json({
                class_level, section, stream, term: currentTerm,
                basis, class_size: 0, students: []
            });
        }

        const ranks = rankStudents(entries);
        const class_size = [...ranks.values()][0]?.class_size ?? 0;
        const scoreById = new Map(entries.map(e => [String(e.student_id), e.score]));

        const [studentRows] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name FROM students
             WHERE school_id = ? AND student_id IN (?)`,
            [req.user.school_id, entries.map(e => e.student_id)]
        );
        const namesById = new Map(studentRows.map(s => [String(s.student_id), [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ')]));

        const students = entries
            .filter(e => e.score != null)
            .map(e => ({
                student_id: e.student_id,
                full_name: namesById.get(String(e.student_id)) || null,
                average: e.score,
                rank: ranks.get(String(e.student_id))?.rank ?? null
            }))
            .sort((a, b) => a.rank - b.rank);

        res.json({ class_level, section, stream, term: currentTerm, basis, class_size, students });
    } catch (err) {
        console.error("/api/homeroom/leaderboard error:", err);
        res.status(500).json({ error: "Could not load the leaderboard" });
    }
});

// --- Homeroom: request access to enter another subject's marks ---
// Covers the case where a subject's own teacher is unavailable (sick,
// on leave, etc.) and the homeroom teacher needs to step in temporarily.
// Rather than opening mark entry to anyone, a homeroom teacher requests
// access to one specific subject for their OWN homeroom section, and an
// Academic VP approves or rejects it. Once approved, hasSubjectAccess()
// (see above isPushedAndLocked/hasSubjectAccess block) treats it exactly
// like a normal teacher_assignments row for /api/add-mark and
// /api/upload-marks — nothing else needs to change once it's approved.
//
// Requires a table (not created elsewhere in this file, so run once):
//   CREATE TABLE IF NOT EXISTS subject_entry_requests (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     school_id INT NOT NULL,
//     teacher_id VARCHAR(50) NOT NULL,
//     subject_id INT NOT NULL,
//     class_level VARCHAR(20) NOT NULL,
//     section VARCHAR(20) NOT NULL,
//     stream VARCHAR(20) NOT NULL,
//     reason TEXT NULL,
//     status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
//     requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     decided_by VARCHAR(50) NULL,
//     decided_at DATETIME NULL,
//     decision_note TEXT NULL
//   );

// Homeroom teacher creates a request for their own section. Blocks a
// request for a subject they're already formally assigned to teach there
// (nothing to request), and blocks a second pending request for the same
// subject+section rather than piling up duplicates.
app.post('/api/teacher/subject-entry-requests', requireAuth, async (req, res) => {
    const { subject_id, reason } = req.body;
    if (!subject_id) {
        return res.status(400).json({ error: "subject_id is required" });
    }

    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            return res.status(403).json({ error: "Only a homeroom teacher can request access to another subject." });
        }
        const { class_level, section, stream } = homeroom;

        const [subjectRows] = await pool.query(
            'SELECT subject_id, subject_name FROM subjects WHERE subject_id = ? AND school_id = ?',
            [subject_id, req.user.school_id]
        );
        if (subjectRows.length === 0) {
            return res.status(404).json({ error: "Subject not found." });
        }

        const alreadyAssigned = await hasSubjectAccess(req.user.user_id, req.user.school_id, subject_id, class_level, section, stream);
        if (alreadyAssigned) {
            return res.status(409).json({ error: "You can already enter marks for this subject in your section — no request needed." });
        }

        const [pending] = await pool.query(
            `SELECT id FROM subject_entry_requests
             WHERE teacher_id = ? AND school_id = ? AND subject_id = ? AND class_level = ? AND section = ? AND stream = ? AND status = 'pending'`,
            [req.user.user_id, req.user.school_id, subject_id, class_level, section, stream]
        );
        if (pending.length > 0) {
            return res.status(409).json({ error: "You already have a pending request for this subject and section." });
        }

        await pool.query(
            `INSERT INTO subject_entry_requests (school_id, teacher_id, subject_id, class_level, section, stream, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [req.user.school_id, req.user.user_id, subject_id, class_level, section, stream, reason || null]
        );
        res.json({ message: `Request sent to the Academic VP to enter ${subjectRows[0].subject_name} marks for your section.` });
    } catch (err) {
        console.error("/api/teacher/subject-entry-requests POST error:", err);
        res.status(500).json({ error: "Could not submit request" });
    }
});

// Homeroom teacher's own requests (any status) — so they can see whether
// they're still pending, approved, or were turned down.
app.get('/api/teacher/subject-entry-requests', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT r.id, r.subject_id, s.subject_name, r.class_level, r.section, r.stream,
                    r.reason, r.status, r.requested_at, r.decided_at, r.decision_note
             FROM subject_entry_requests r
             JOIN subjects s ON s.subject_id = r.subject_id AND s.school_id = r.school_id
             WHERE r.teacher_id = ? AND r.school_id = ?
             ORDER BY r.requested_at DESC`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/teacher/subject-entry-requests GET error:", err);
        res.status(500).json({ error: "Could not load your requests" });
    }
});

// Academic VP: pending requests awaiting a decision.
app.get('/api/academic-vp/subject-entry-requests', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT r.id, r.teacher_id, t.first_name, t.middle_name, t.last_name,
                    r.subject_id, s.subject_name, r.class_level, r.section, r.stream,
                    r.reason, r.status, r.requested_at
             FROM subject_entry_requests r
             JOIN subjects s ON s.subject_id = r.subject_id AND s.school_id = r.school_id
             JOIN teachers t ON t.teacher_id = r.teacher_id AND t.school_id = r.school_id
             WHERE r.school_id = ? AND r.status = 'pending'
             ORDER BY r.requested_at ASC`,
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/academic-vp/subject-entry-requests GET error:", err);
        res.status(500).json({ error: "Could not load subject entry requests" });
    }
});

app.post('/api/academic-vp/subject-entry-requests/:id/approve', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT id FROM subject_entry_requests WHERE id = ? AND school_id = ? AND status = 'pending'`,
            [req.params.id, req.user.school_id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "Request not found or already decided." });
        }
        await pool.query(
            `UPDATE subject_entry_requests SET status = 'approved', decided_by = ?, decided_at = NOW() WHERE id = ?`,
            [req.user.user_id, req.params.id]
        );
        res.json({ message: "Approved — the teacher can now enter marks for this subject in that section." });
    } catch (err) {
        console.error("/api/academic-vp/subject-entry-requests/:id/approve error:", err);
        res.status(500).json({ error: "Could not approve this request" });
    }
});

app.post('/api/academic-vp/subject-entry-requests/:id/reject', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { reason } = req.body;
    try {
        const [rows] = await pool.query(
            `SELECT id FROM subject_entry_requests WHERE id = ? AND school_id = ? AND status = 'pending'`,
            [req.params.id, req.user.school_id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "Request not found or already decided." });
        }
        await pool.query(
            `UPDATE subject_entry_requests SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?`,
            [req.user.user_id, reason || null, req.params.id]
        );
        res.json({ message: "Request rejected." });
    } catch (err) {
        console.error("/api/academic-vp/subject-entry-requests/:id/reject error:", err);
        res.status(500).json({ error: "Could not reject this request" });
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
            `SELECT student_id, first_name, middle_name, last_name FROM students
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
            middle_name: s.middle_name,
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
            // Lets the "My Class" page show a yellow "Today is a
            // holiday" banner instead of an alarming "Not Yet Marked"
            // count — attendance genuinely isn't expected today.
            is_holiday: !!getEthiopianHolidayName(new Date()),
            holiday_name: getEthiopianHolidayName(new Date()),
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
            if (req.file) fs.unlink(req.file.path, () => { });
            return res.status(400).json({ error: "student_id is required" });
        }
        if (!req.file) return res.status(400).json({ error: "No photo uploaded" });
        if (!req.file.mimetype.startsWith('image/')) {
            fs.unlink(req.file.path, () => { });
            return res.status(400).json({ error: "Photo must be an image file (JPEG, PNG, GIF, or WEBP)." });
        }

        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) {
            fs.unlink(req.file.path, () => { });
            return res.status(403).json({ error: "You are not a homeroom teacher." });
        }

        const converted = await convertHeicIfNeeded(req.file);
        if (converted) req.file = converted;

        const dimensions = tryReadImageDimensions(req.file.path);
        if (dimensions) {
            const { width, height } = dimensions;
            const shortSide = Math.min(width, height);
            const longSide = Math.max(width, height);
            if (shortSide < ID_PHOTO_MIN_WIDTH || longSide < ID_PHOTO_MIN_HEIGHT) {
                fs.unlink(req.file.path, () => { });
                return res.status(400).json({
                    error: `Photo is too small (was ${width}×${height}px). Please use a clearer, higher-resolution photo.`
                });
            }
        }

        const [studentRows] = await pool.query(
            'SELECT student_id, first_name, last_name, id_photo_url FROM students WHERE student_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?',
            [student_id, homeroom.class_level, homeroom.section, homeroom.stream, req.user.school_id]
        );
        if (studentRows.length === 0) {
            fs.unlink(req.file.path, () => { });
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
            fs.unlink(oldPath, () => { });
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
            `Your absence request for ${formatDualDateText(request.date_from)} to ${formatDualDateText(request.date_to)} was approved by your homeroom teacher.`
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
            `Your absence request for ${formatDualDateText(request.date_from)} to ${formatDualDateText(request.date_to)} was rejected by your homeroom teacher.${reason ? ' Reason: ' + reason : ''}`
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
            `Your absence request for ${formatDualDateText(request.date_from)} to ${formatDualDateText(request.date_to)} needs review by school administration and has been forwarded to them.`
        );
        res.json({ message: "Escalated to Admin for review." });
    } catch (err) {
        console.error("/api/homeroom/absence-requests/:id/escalate error:", err);
        res.status(500).json({ error: "Could not escalate this request" });
    }
});

// --- Academic VP: escalated student absence / permission requests ---
// Was previously open to any school_admins account; now scoped to
// Academic VP specifically, since that's who owns academic/attendance
// escalations for students (Admin VP handles teacher absence instead —
// see /api/admin/teacher-absence-requests).
app.get('/api/admin/absence-requests', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
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

app.post('/api/admin/absence-requests/:id/approve', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
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
            `Your absence request for ${formatDualDateText(request.date_from)} to ${formatDualDateText(request.date_to)} was approved by school administration.`
        );
        res.json({ message: "Approved. These days won't count as unexcused absences." });
    } catch (err) {
        console.error("/api/admin/absence-requests/:id/approve error:", err);
        res.status(500).json({ error: "Could not approve this request" });
    }
});

app.post('/api/admin/absence-requests/:id/reject', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
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
            `Your absence request for ${formatDualDateText(request.date_from)} to ${formatDualDateText(request.date_to)} was rejected by school administration.${reason ? ' Reason: ' + reason : ''}`
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
//
// Penalty decisions live one level up from the homeroom teacher — a
// homeroom teacher can only report a book lost; Admin VP decides what
// happens next (charge, waive, warning) from the school-wide textbook
// view. Requires these columns on textbook_distributions — ADD THEM if
// they don't exist yet:
//   ALTER TABLE textbook_distributions
//     ADD COLUMN penalty_status ENUM('none','pending','waived','charged') NOT NULL DEFAULT 'none',
//     ADD COLUMN penalty_amount DECIMAL(10,2) NULL,
//     ADD COLUMN penalty_note VARCHAR(255) NULL,
//     ADD COLUMN penalty_decided_by VARCHAR(50) NULL,
//     ADD COLUMN penalty_decided_at DATETIME NULL;
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
        // Marking a book "lost" also opens a penalty case for Admin VP —
        // the homeroom teacher only reports that the book is gone; whether
        // the student is charged, warned, or waived is Admin VP's call,
        // made from the Admin/VP textbook view (see /api/admin/textbooks
        // and /api/admin/textbooks/penalty), not something decided here.
        const [result] = await pool.query(
            `UPDATE textbook_distributions
             SET status = 'lost', lost_at = NOW(), lost_reported_by = ?, penalty_status = 'pending',
                 penalty_amount = NULL, penalty_note = NULL, penalty_decided_by = NULL, penalty_decided_at = NULL
             WHERE student_id = ? AND subject_id = ? AND school_year = ? AND school_id = ? AND status = 'issued'`,
            [req.user.user_id, student_id, subject_id, school_year, req.user.school_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "No active (issued, unreturned) distribution found for this student/subject." });
        }

        res.json({ message: "Textbook marked as lost. Admin VP will review and decide on any penalty." });
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
             SET status = 'issued', lost_at = NULL, lost_reported_by = NULL, penalty_status = 'none',
                 penalty_amount = NULL, penalty_note = NULL, penalty_decided_by = NULL, penalty_decided_at = NULL
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

// --- Academic VP: review every homeroom's pushed marks for the current
// term, and see who hasn't pushed yet ---
// Enumerates every homeroom section from teachers.homeroom_* (a teacher
// counts as "homeroom" when those columns are set) and left-joins
// pushed_marks_reports for the current term, so a homeroom that hasn't
// pushed just comes back with pushed_at: null instead of being silently
// absent from the list.
app.get('/api/academic-vp/marks-review', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    try {
        const term = await getCurrentTerm(req.user.school_id);
        const [rows] = await pool.query(
            `SELECT t.teacher_id, t.first_name, t.last_name,
                    t.homeroom_class_level AS class_level, t.homeroom_section AS section, t.homeroom_stream AS stream,
                    p.pushed_at,
                    SUM(CASE WHEN sts.status = 'Incomplete' THEN 1 ELSE 0 END) AS incomplete_count,
                    SUM(CASE WHEN sts.status = 'Dropout' THEN 1 ELSE 0 END) AS dropout_count
             FROM teachers t
             LEFT JOIN pushed_marks_reports p
                 ON p.school_id = t.school_id
                 AND p.class_level = t.homeroom_class_level AND p.section = t.homeroom_section AND p.stream = t.homeroom_stream
                 AND p.term = ?
             LEFT JOIN student_term_status sts
                 ON sts.school_id = t.school_id
                 AND sts.class_level = t.homeroom_class_level AND sts.section = t.homeroom_section AND sts.stream = t.homeroom_stream
                 AND sts.term = ?
             WHERE t.school_id = ? AND t.homeroom_class_level IS NOT NULL
             GROUP BY t.teacher_id, t.first_name, t.last_name, t.homeroom_class_level, t.homeroom_section, t.homeroom_stream, p.pushed_at
             ORDER BY t.homeroom_class_level, t.homeroom_section`,
            [term, term, req.user.school_id]
        );
        res.json(rows.map(r => ({
            teacher_id: r.teacher_id,
            full_name: `${r.first_name} ${r.last_name}`,
            class_level: r.class_level,
            section: r.section,
            stream: r.stream,
            pushed: !!r.pushed_at,
            pushed_at: r.pushed_at,
            // Only meaningful once pushed — a homeroom teacher can still
            // be mid-review with unflagged students otherwise.
            incomplete_count: r.pushed_at ? Number(r.incomplete_count) : 0,
            dropout_count: r.pushed_at ? Number(r.dropout_count) : 0
        })));
    } catch (err) {
        console.error("/api/academic-vp/marks-review error:", err);
        res.status(500).json({ error: "Could not load the marks review" });
    }
});

// --- Academic VP: the compiled master sheet for one section, once its
// homeroom teacher has pushed it — same per-subject totals as
// /api/homeroom/section-report, plus the Incomplete/Dropout list the
// homeroom teacher finalized before pushing. Locked to sections that
// have actually been pushed for the requested term, since an unpushed
// section's review is still the homeroom teacher's to finish.
app.get('/api/academic-vp/section-master-sheet', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { class_level, section, stream } = req.query;
    if (!class_level || !section || !stream) {
        return res.status(400).json({ error: "class_level, section, and stream are required" });
    }

    try {
        const term = await getCurrentTerm(req.user.school_id);

        const [pushRows] = await pool.query(
            'SELECT pushed_at FROM pushed_marks_reports WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ?',
            [req.user.school_id, class_level, section, stream, term]
        );
        if (pushRows.length === 0) {
            return res.status(404).json({ error: `This section's ${term} report hasn't been pushed to you yet.` });
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

        const [statusRows] = await pool.query(
            `SELECT student_id, status FROM student_term_status
             WHERE school_id = ? AND class_level = ? AND section = ? AND stream = ? AND term = ?`,
            [req.user.school_id, class_level, section, stream, term]
        );
        const statusByStudent = {};
        statusRows.forEach(r => { statusByStudent[r.student_id] = r.status; });

        const subjectNames = [...new Set(scoreRows.map(r => r.subject_name))].sort();
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
                subjects[name] = { semester_1: s1, semester_2: s2, year_average: yearAverage(s1, s2) };
            });
            const subjectValues = Object.values(subjects);
            return {
                student_id: student.student_id,
                full_name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' '),
                subjects,
                semester_1_average: overallAverage(subjectValues.map(s => s.semester_1)),
                semester_2_average: overallAverage(subjectValues.map(s => s.semester_2)),
                year_average: overallAverage(subjectValues.map(s => s.year_average)),
                status: statusByStudent[student.student_id] || 'Active'
            };
        });

        res.json({
            class_level, section, stream, term,
            pushed_at: pushRows[0].pushed_at,
            subject_columns: subjectNames,
            students: report,
            incomplete_students: report.filter(r => r.status === 'Incomplete').map(r => ({ student_id: r.student_id, full_name: r.full_name })),
            dropout_students: report.filter(r => r.status === 'Dropout').map(r => ({ student_id: r.student_id, full_name: r.full_name }))
        });
    } catch (err) {
        console.error("/api/academic-vp/section-master-sheet error:", err);
        res.status(500).json({ error: "Could not load this section's master sheet" });
    }
});

// --- Academic VP: student conduct — a warning is theirs to give
// directly (goes straight to the student as a notification); anything
// termination-level is handed to the Principal as a case instead of
// decided here.
//
// Requires a new table — run this migration if it doesn't exist yet:
//   CREATE TABLE student_disciplinary_cases (
//     case_id INT AUTO_INCREMENT PRIMARY KEY,
//     student_id VARCHAR(50) NOT NULL,
//     school_id INT NOT NULL,
//     raised_by VARCHAR(50) NOT NULL, -- Academic VP's admin_id
//     description TEXT NOT NULL,
//     status ENUM('pending','dismissed','terminated') NOT NULL DEFAULT 'pending',
//     decided_by VARCHAR(50) NULL, -- Principal's admin_id
//     decided_at DATETIME NULL,
//     decision_note VARCHAR(255) NULL,
//     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     INDEX idx_student_case (student_id, school_id)
//   );
app.post('/api/academic-vp/conduct-warning', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { student_id, message } = req.body;
    if (!student_id || !message?.trim()) {
        return res.status(400).json({ error: "student_id and message are required" });
    }
    try {
        await notifyStudent(student_id, req.user.school_id, req.user.user_id, 'conduct_warning', message.trim());
        res.json({ message: "Warning sent to student." });
    } catch (err) {
        console.error("/api/academic-vp/conduct-warning error:", err);
        res.status(500).json({ error: "Could not send warning" });
    }
});

// Academic VP hands a termination-level case to the Principal — this
// doesn't terminate anyone by itself, it just opens the case for the
// Principal to decide on.
app.post('/api/academic-vp/disciplinary-cases', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { student_id, description } = req.body;
    if (!student_id || !description?.trim()) {
        return res.status(400).json({ error: "student_id and description are required" });
    }
    try {
        const [result] = await pool.query(
            `INSERT INTO student_disciplinary_cases (student_id, school_id, raised_by, description)
             VALUES (?, ?, ?, ?)`,
            [student_id, req.user.school_id, req.user.user_id, description.trim()]
        );
        res.json({ message: "Case handed to the Principal.", case_id: result.insertId });
    } catch (err) {
        console.error("/api/academic-vp/disciplinary-cases error:", err);
        res.status(500).json({ error: "Could not open a disciplinary case" });
    }
});

// --- Principal: decide pending disciplinary cases ---
app.get('/api/principal/disciplinary-cases', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT c.case_id, c.student_id, st.first_name, st.last_name, st.class_level, st.section, st.stream,
                    c.raised_by, c.description, c.status, c.created_at
             FROM student_disciplinary_cases c
             JOIN students st ON st.student_id = c.student_id AND st.school_id = c.school_id
             WHERE c.school_id = ? AND c.status = 'pending'
             ORDER BY c.created_at ASC`,
            [req.user.school_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("/api/principal/disciplinary-cases GET error:", err);
        res.status(500).json({ error: "Could not load disciplinary cases" });
    }
});

app.post('/api/principal/disciplinary-cases/:id/decide', requireAuth, requirePrincipal, async (req, res) => {
    const { decision, note } = req.body; // decision: 'dismissed' | 'terminated'
    if (!['dismissed', 'terminated'].includes(decision)) {
        return res.status(400).json({ error: "decision must be 'dismissed' or 'terminated'" });
    }
    try {
        const [rows] = await pool.query(
            `SELECT * FROM student_disciplinary_cases WHERE case_id = ? AND school_id = ? AND status = 'pending'`,
            [req.params.id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Case not found or already decided." });
        const disciplinaryCase = rows[0];

        await pool.query(
            `UPDATE student_disciplinary_cases SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ? WHERE case_id = ?`,
            [decision, req.user.user_id, note || null, disciplinaryCase.case_id]
        );
        await notifyStudent(
            disciplinaryCase.student_id, req.user.school_id, req.user.user_id, 'disciplinary_decision',
            decision === 'terminated' ? "Your enrollment has been terminated. Contact the Principal's office." : "Your disciplinary case has been reviewed and dismissed."
        );
        res.json({ message: `Case ${decision}.` });
    } catch (err) {
        console.error("/api/principal/disciplinary-cases/:id/decide error:", err);
        res.status(500).json({ error: "Could not decide this case" });
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
app.get('/api/admin/textbooks', requireAuth, requireAdminTitle('Admin VP'), async (req, res) => {
    try {
        const school_year = getSchoolYear();

        const [log] = await pool.query(
            `SELECT td.student_id, st.first_name, st.middle_name, st.last_name,
                    st.class_level, st.section, st.stream,
                    s.subject_id, s.subject_name,
                    td.issued_by, td.issued_at, td.status, td.returned_at, td.lost_at,
                    td.penalty_status, td.penalty_amount, td.penalty_note,
                    td.penalty_decided_by, td.penalty_decided_at
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
                subject_id: r.subject_id,
                subject_name: r.subject_name,
                issued_by: r.issued_by,
                issued_at: r.issued_at,
                status: r.status,
                returned_at: r.returned_at,
                lost_at: r.lost_at,
                penalty_status: r.penalty_status,
                penalty_amount: r.penalty_amount,
                penalty_note: r.penalty_note,
                penalty_decided_by: r.penalty_decided_by,
                penalty_decided_at: r.penalty_decided_at
            }))
        });
    } catch (err) {
        console.error("admin textbooks error:", err);
        res.status(500).json({ error: "Could not load textbook records" });
    }
});

// Admin VP records the penalty decision for a lost textbook — waive it,
// charge a specific amount, or leave a note (e.g. "replacement brought
// in"). This is intentionally separate from the homeroom teacher's
// /api/homeroom/textbooks/lost, which only reports that a book is gone;
// deciding the consequence is Admin VP's call, scoped across every
// homeroom section in the school (not just one teacher's own).
app.post('/api/admin/textbooks/penalty', requireAuth, requireAdminTitle('Admin VP'), async (req, res) => {
    const { student_id, subject_id, decision, amount, note } = req.body;
    if (!student_id || !subject_id || !decision) {
        return res.status(400).json({ error: "student_id, subject_id, and decision are required" });
    }
    if (!['waived', 'charged'].includes(decision)) {
        return res.status(400).json({ error: "decision must be 'waived' or 'charged'" });
    }
    if (decision === 'charged' && (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) < 0)) {
        return res.status(400).json({ error: "A valid, non-negative amount is required when charging a student." });
    }

    try {
        const school_year = getSchoolYear();
        const [result] = await pool.query(
            `UPDATE textbook_distributions
             SET penalty_status = ?, penalty_amount = ?, penalty_note = ?,
                 penalty_decided_by = ?, penalty_decided_at = NOW()
             WHERE student_id = ? AND subject_id = ? AND school_year = ? AND school_id = ? AND status = 'lost'`,
            [decision, decision === 'charged' ? Number(amount) : null, note || null,
                req.user.user_id, student_id, subject_id, school_year, req.user.school_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "No textbook marked Lost was found for this student/subject." });
        }
        res.json({ message: `Penalty recorded: ${decision}.` });
    } catch (err) {
        console.error("admin textbook penalty error:", err);
        res.status(500).json({ error: "Could not record penalty decision" });
    }
});

// --- Contact School Management ---
// Recipients are role labels ('Principal', 'Admin VP', 'Academic VP'), not
// specific admin_id values. Whoever holds that role (via school_admins.role)
// will see threads addressed to them once the admin inbox is built.
const MANAGEMENT_ROLES = ['Principal', 'Admin VP', 'Academic VP'];
const CONTACT_CATEGORIES = ['Permission Request', 'Complaint', 'General Inquiry'];

// Optional additional roles a thread is tagged with, beyond the single
// recipient_role — e.g. an absence request always goes to Admin VP but
// also tags Academic VP and Principal so they're aware without being the
// primary responder. Stored as a comma-separated string of MANAGEMENT_ROLES
// values.
//   ALTER TABLE contact_threads ADD COLUMN cc_roles VARCHAR(255) NULL;
function parseCcRoles(raw) {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : String(raw).split(',').map(r => r.trim());
    return [...new Set(list.filter(r => MANAGEMENT_ROLES.includes(r)))];
}

// Teacher starts a new thread.
app.post('/api/contact/new', requireAuth, async (req, res) => {
    const { recipient_role, category, subject, body, cc_roles } = req.body;

    if (!recipient_role || !category || !subject || !body) {
        return res.status(400).json({ error: "recipient_role, category, subject, and body are all required" });
    }
    if (!MANAGEMENT_ROLES.includes(recipient_role)) {
        return res.status(400).json({ error: `recipient_role must be one of: ${MANAGEMENT_ROLES.join(', ')}` });
    }
    if (!CONTACT_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${CONTACT_CATEGORIES.join(', ')}` });
    }

    const ccRoleList = parseCcRoles(cc_roles).filter(r => r !== recipient_role);

    try {
        const [threadResult] = await pool.query(
            `INSERT INTO contact_threads (teacher_id, recipient_role, cc_roles, category, subject, school_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [req.user.user_id, recipient_role, ccRoleList.join(',') || null, category, subject, req.user.school_id]
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
            `SELECT t.thread_id, t.recipient_role, t.cc_roles, t.category, t.subject, t.status, t.updated_at,
                    (SELECT COUNT(*) FROM contact_messages WHERE thread_id = t.thread_id) as message_count
             FROM contact_threads t
             WHERE t.teacher_id = ? AND t.school_id = ?
             ORDER BY t.updated_at DESC`,
            [req.user.user_id, req.user.school_id]
        );
        res.json(threads.map(t => ({ ...t, cc_roles: t.cc_roles ? t.cc_roles.split(',') : [] })));
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

        const thread = { ...threadRows[0], cc_roles: threadRows[0].cc_roles ? threadRows[0].cc_roles.split(',') : [] };
        res.json({ thread, messages });
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

// Teacher (owner) or an addressed school_admins (recipient_role or
// cc_roles matches their title) can toggle Open/Resolved.
app.post('/api/contact/thread/:thread_id/status', requireAuth, async (req, res) => {
    const { status } = req.body;
    const { thread_id } = req.params;

    if (!['Open', 'Resolved'].includes(status)) {
        return res.status(400).json({ error: "status must be 'Open' or 'Resolved'" });
    }

    try {
        const [threadRows] = await pool.query(
            'SELECT teacher_id, recipient_role, cc_roles FROM contact_threads WHERE thread_id = ? AND school_id = ?',
            [thread_id, req.user.school_id]
        );
        if (threadRows.length === 0) return res.status(404).json({ error: "Thread not found" });
        const thread = threadRows[0];
        const isOwner = thread.teacher_id === req.user.user_id;
        const isAddressedAdmin = req.user.role === 'school_admins' &&
            (thread.recipient_role === req.user.title || parseCcRoles(thread.cc_roles).includes(req.user.title));
        if (!isOwner && !isAddressedAdmin) {
            return res.status(403).json({ error: "This isn't your thread." });
        }

        await pool.query('UPDATE contact_threads SET status = ?, updated_at = NOW() WHERE thread_id = ? AND school_id = ?', [status, thread_id, req.user.school_id]);
        res.json({ message: `Marked as ${status}.` });
    } catch (err) {
        console.error("contact/status error:", err);
        res.status(500).json({ error: "Could not update status" });
    }
});

// --- (4b) Admin-side inbox for the Contact School system above ---
// Teachers already send threads addressed to a management role
// (Principal / Admin VP / Academic VP) via /api/contact/new, but until
// now nothing on the school_admins side could read them — this is the
// "admin inbox" referenced in the comments above. A thread is visible to
// an admin if their title matches recipient_role, or appears in cc_roles.
// Requires this column if it doesn't exist yet (mirrors teachers' own
// last_read_at, but scoped to the admin side of the same thread):
//   ALTER TABLE contact_threads ADD COLUMN admin_last_read_at DATETIME NULL;
app.get('/api/admin/contact-threads', requireAuth, requireRole('school_admins'), async (req, res) => {
    try {
        const [threads] = await pool.query(
            `SELECT t.thread_id, t.teacher_id, t.recipient_role, t.cc_roles, t.category, t.subject,
                    t.status, t.updated_at, t.admin_last_read_at,
                    te.first_name AS teacher_first_name, te.last_name AS teacher_last_name,
                    (SELECT COUNT(*) FROM contact_messages m WHERE m.thread_id = t.thread_id
                        AND m.sender_role = 'teacher'
                        AND (t.admin_last_read_at IS NULL OR m.sent_at > t.admin_last_read_at)) AS unread_count
             FROM contact_threads t
             LEFT JOIN teachers te ON te.teacher_id = t.teacher_id AND te.school_id = t.school_id
             WHERE t.school_id = ? AND (t.recipient_role = ? OR FIND_IN_SET(?, t.cc_roles))
             ORDER BY t.updated_at DESC`,
            [req.user.school_id, req.user.title, req.user.title]
        );
        res.json(threads.map(t => ({
            ...t,
            cc_roles: t.cc_roles ? t.cc_roles.split(',') : [],
            teacher_name: [t.teacher_first_name, t.teacher_last_name].filter(Boolean).join(' ') || t.teacher_id
        })));
    } catch (err) {
        console.error("/api/admin/contact-threads error:", err);
        res.status(500).json({ error: "Could not load messages from teachers" });
    }
});

app.get('/api/admin/contact-threads/:thread_id', requireAuth, requireRole('school_admins'), async (req, res) => {
    const { thread_id } = req.params;
    try {
        const [threadRows] = await pool.query(
            'SELECT * FROM contact_threads WHERE thread_id = ? AND school_id = ?',
            [thread_id, req.user.school_id]
        );
        if (threadRows.length === 0) return res.status(404).json({ error: "Thread not found" });
        const thread = threadRows[0];
        const isAddressed = thread.recipient_role === req.user.title || parseCcRoles(thread.cc_roles).includes(req.user.title);
        if (!isAddressed) return res.status(403).json({ error: "This thread isn't addressed to your role." });

        const [messages] = await pool.query(
            'SELECT sender_role, sender_id, body, sent_at FROM contact_messages WHERE thread_id = ? AND school_id = ? ORDER BY sent_at ASC',
            [thread_id, req.user.school_id]
        );

        // Reading the thread counts as catching up on it.
        await pool.query('UPDATE contact_threads SET admin_last_read_at = NOW() WHERE thread_id = ? AND school_id = ?', [thread_id, req.user.school_id]);

        res.json({ thread: { ...thread, cc_roles: thread.cc_roles ? thread.cc_roles.split(',') : [] }, messages });
    } catch (err) {
        console.error("/api/admin/contact-threads/:thread_id error:", err);
        res.status(500).json({ error: "Could not load this thread" });
    }
});

// If contact_messages.sender_role is a narrow ENUM rather than VARCHAR,
// it needs 'admin' added: ALTER TABLE contact_messages MODIFY COLUMN
// sender_role ENUM('teacher','admin') NOT NULL;
app.post('/api/admin/contact-threads/:thread_id/reply', requireAuth, requireRole('school_admins'), async (req, res) => {
    const { body } = req.body;
    const { thread_id } = req.params;
    if (!body?.trim()) return res.status(400).json({ error: "body is required" });

    try {
        const [threadRows] = await pool.query(
            'SELECT recipient_role, cc_roles FROM contact_threads WHERE thread_id = ? AND school_id = ?',
            [thread_id, req.user.school_id]
        );
        if (threadRows.length === 0) return res.status(404).json({ error: "Thread not found" });
        const thread = threadRows[0];
        const isAddressed = thread.recipient_role === req.user.title || parseCcRoles(thread.cc_roles).includes(req.user.title);
        if (!isAddressed) return res.status(403).json({ error: "This thread isn't addressed to your role." });

        await pool.query(
            `INSERT INTO contact_messages (thread_id, sender_role, sender_id, body, school_id) VALUES (?, 'admin', ?, ?, ?)`,
            [thread_id, req.user.user_id, body.trim(), req.user.school_id]
        );
        await pool.query(
            'UPDATE contact_threads SET updated_at = NOW(), admin_last_read_at = NOW() WHERE thread_id = ? AND school_id = ?',
            [thread_id, req.user.school_id]
        );
        res.json({ message: "Reply sent." });
    } catch (err) {
        console.error("/api/admin/contact-threads/:thread_id/reply error:", err);
        res.status(500).json({ error: "Could not send reply" });
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

// This is the "Start Semester" button — Academic VP (or any school_admins
// account, per the loose gating noted elsewhere in this file) calls this
// to both (a) set which term new marks get stamped with, and (b) mark
// TODAY as the day counting starts for that term. That second part is
// what countAbsentDays(), the attendance heatmap calendar, and the
// streak all key off of — none of them will count a day before this
// timestamp, no matter how far back their own query window reaches.
// Pushing this again (e.g. correcting a mistake, or moving to Semester 2)
// resets the start date to today each time — the clock always reflects
// the most recent press of the button, not the first ever.
app.post('/api/term/set', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
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

// --- Semester Archive ---
// Freezes the School Performance widgets (academic marks, student
// attendance, teacher attendance, class coverage) the moment a semester is
// closed (POST /api/term/close below), so the Principal dashboard can keep
// showing last semester's numbers in a dedicated "Last Semester" widget
// even after the live widgets reset to (near) zero for the new term — see
// the term_start_date clamp in /api/principal/school-performance above.
// One row per close; never overwritten or deleted, so a school that
// re-opens/closes a term more than once (e.g. correcting a mistake) still
// keeps every past snapshot — the "last semester" endpoint below just
// reads the most recent one.
//   CREATE TABLE IF NOT EXISTS semester_archives (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     school_id INT NOT NULL,
//     term VARCHAR(20) NOT NULL,
//     term_start_date DATE NULL,
//     window_since DATE NULL,
//     window_until DATE NULL,
//     snapshot JSON NOT NULL,
//     archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     INDEX idx_school_archived (school_id, archived_at)
//   );
async function archiveSchoolPerformance(school_id, term, termStartDate) {
    const today = toDateOnly(new Date());
    // Use the whole term-to-date window here (not the trailing-30-days cap
    // the live widget uses), so what gets frozen is "all of this semester
    // so far", not just its last 30 days.
    const since = termStartDate || toDateOnly(new Date(Date.now() - 30 * 86400000));
    const snapshot = await computeSchoolPerformance(school_id, since, today, term);
    await pool.query(
        `INSERT INTO semester_archives (school_id, term, term_start_date, window_since, window_until, snapshot)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [school_id, term, termStartDate, since, today, JSON.stringify(snapshot)]
    );
}

// "Close Semester" — Academic VP marks the currently active term as
// closed (e.g. once every section's marks have been pushed and the term
// is administratively wrapped up). Deliberately doesn't touch
// current_term or term_start_date: the label everyone sees should read
// "Closed · Semester 1", not silently reset to some other term. Re-opens
// via POST /api/term/set (Start Semester) same as above.
app.post('/api/term/close', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    try {
        const term = await getCurrentTerm(req.user.school_id);
        const termStartDate = await getTermStartDate(req.user.school_id);
        // Freeze this semester's numbers into the archive BEFORE flipping
        // status to closed, so the Principal's "Last Semester" widget has
        // something to show the moment this semester ends — and so the
        // very next "Start Semester" press (which resets term_start_date)
        // can't wipe out the source data first.
        await archiveSchoolPerformance(req.user.school_id, term, termStartDate);
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

// Principal-only: the most recently archived semester snapshot, for the
// "Last Semester Performance" dashboard widget. Read-only and frozen at
// the moment the semester was closed — never recalculated live, so it
// keeps reading the same numbers no matter how much time passes or how
// many students/teachers come and go afterward. Returns null if no
// semester has ever been closed yet for this school.
app.get('/api/principal/last-semester-performance', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT term, term_start_date, window_since, window_until, snapshot, archived_at
             FROM semester_archives WHERE school_id = ? ORDER BY archived_at DESC LIMIT 1`,
            [req.user.school_id]
        );
        if (rows.length === 0) return res.json(null);
        const row = rows[0];
        const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
        res.json({
            term: row.term,
            archived_at: row.archived_at,
            window: { since: toDateOnly(new Date(row.window_since)), until: toDateOnly(new Date(row.window_until)) },
            academic: snapshot.academic,
            student_attendance: snapshot.student_attendance,
            teacher_attendance: snapshot.teacher_attendance,
            class_coverage: snapshot.class_coverage
        });
    } catch (err) {
        console.error("/api/principal/last-semester-performance error:", err);
        res.status(500).json({ error: "Could not load last semester's performance" });
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

        // Also include any section this teacher holds an APPROVED
        // subject_entry_request for (covering another subject there) even
        // if they have no teacher_assignments row for that section at all
        // — otherwise the bulk gradesheet page would have no way to pick
        // that section to enter the covered subject's marks.
        const [coveringRows] = await pool.query(
            `SELECT DISTINCT class_level, section, stream
             FROM subject_entry_requests
             WHERE teacher_id = ? AND school_id = ? AND status = 'approved'`,
            [req.user.user_id, req.user.school_id]
        );

        const combined = new Map();
        [...rows, ...coveringRows].forEach(r => combined.set(`${r.class_level}|${r.section}|${r.stream}`, r));
        res.json([...combined.values()]);
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
        { table: 'school_admins', idCol: 'admin_id' },
        { table: 'zonal_admins', idCol: 'admin_id' },
        { table: 'super_admins', idCol: 'admin_id' },
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
        // round trip, and so we know what to put in the token. Zonal
        // admins with a real zone_id also get their zone's name, in
        // addition to the existing free-text zone column.
        let school_name = null;
        let zone_name = null;
        if (user.school_id) {
            const [schoolRows] = await pool.query('SELECT school_name FROM schools WHERE id = ?', [user.school_id]);
            if (schoolRows.length > 0) school_name = schoolRows[0].school_name;
        }
        if (userRole === 'zonal_admins' && user.zone_id) {
            const [zoneRows] = await pool.query('SELECT zone_name FROM zones WHERE zone_id = ?', [user.zone_id]).catch(() => [[]]);
            if (zoneRows && zoneRows.length > 0) zone_name = zoneRows[0].zone_name;
        }

        issueAuthToken(res, {
            user_id: id,
            role: userRole,
            school_id: user.school_id || null,
            zone: user.zone || null,
            zone_id: user.zone_id || null,
            title: user.title || null,
            is_class_monitor: userRole === 'students' ? !!user.is_class_monitor : false,
            can_act_independently: userRole === 'zonal_admins' ? !!user.can_act_independently : false
        });

        // The token itself is httpOnly and never exposed to JS — this JSON
        // body is just for the frontend to know who's logged in and update
        // the UI (e.g. the school name in the header), not for auth itself.
        res.json({
            message: "Login successful",
            role: userRole,
            id: id,
            school_id: user.school_id || null,
            zone: user.zone || null,
            zone_id: user.zone_id || null,
            zone_name,
            title: user.title || null,
            can_act_independently: userRole === 'zonal_admins' ? !!user.can_act_independently : false,
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
        let logo_url = null;
        if (req.user.school_id) {
            const [schoolRows] = await pool.query(
                'SELECT school_name, moe_school_code, logo_url FROM schools WHERE id = ?',
                [req.user.school_id]
            );
            if (schoolRows.length > 0) {
                school_name = schoolRows[0].school_name;
                moe_school_code = schoolRows[0].moe_school_code;
                logo_url = schoolRows[0].logo_url || null;
            }
        }

        let zone_name = null;
        if (req.user.role === 'zonal_admins' && req.user.zone_id) {
            const [zoneRows] = await pool.query('SELECT zone_name FROM zones WHERE zone_id = ?', [req.user.zone_id]).catch(() => [[]]);
            if (zoneRows && zoneRows.length > 0) zone_name = zoneRows[0].zone_name;
        }

        let additional_role = null;
        let is_recorder = false;
        let is_registrar_flag = false;
        let avatar_url = null;
        let registrar_signature_url = null;
        let admin_full_name = null;
        let id_photo_url = null;
        if (req.user.role === 'teachers') {
            const [teacherRows] = await pool.query(
                'SELECT additional_role, is_registrar, is_recorder, avatar_url, registrar_signature_url FROM teachers WHERE teacher_id = ? AND school_id = ?',
                [req.user.user_id, req.user.school_id]
            );
            if (teacherRows.length > 0) {
                additional_role = teacherRows[0].additional_role || null;
                is_registrar_flag = !!teacherRows[0].is_registrar;
                is_recorder = !!teacherRows[0].is_recorder;
                avatar_url = teacherRows[0].avatar_url || null;
                registrar_signature_url = teacherRows[0].registrar_signature_url || null;
            }
        } else if (req.user.role === 'school_admins') {
            // Same self-serve avatar pattern as teachers — see
            // /api/admin/upload-avatar and the school_admins.avatar_url
            // column added alongside signature_url/stamp_url below.
            // id_photo_url is a separate, ID-card-only photo — see the
            // comment on /api/admin/upload-id-photo for why this isn't
            // just reused from avatar_url.
            const [adminRows] = await pool.query(
                'SELECT first_name, middle_name, last_name, avatar_url, id_photo_url FROM school_admins WHERE admin_id = ? AND school_id = ?',
                [req.user.user_id, req.user.school_id]
            );
            if (adminRows.length > 0) {
                avatar_url = adminRows[0].avatar_url || null;
                id_photo_url = adminRows[0].id_photo_url || null;
                admin_full_name = [adminRows[0].first_name, adminRows[0].middle_name, adminRows[0].last_name].filter(Boolean).join(' ') || null;
            }
        }
        // is_registrar drives app.js's full-admin nav (Section Setup,
        // Placement Wizard, Manage Recorders). True either for a
        // standalone registrar_users account, or a teacher an Academic VP
        // has flagged as Registrar via /api/academic-vp/grant-registrar —
        // both get the same access (see requireRegistrarOnly above).
        const is_registrar = req.user.role === 'registrar_users' || is_registrar_flag;

        // Shown in the top-bar next to the MOE/semester badges — every
        // role gets the same school-wide value, so it's computed here
        // once rather than duplicated per role branch above.
        const academic_year = getCurrentAcademicYearLabel();

        res.json({
            user_id: req.user.user_id,
            role: req.user.role,
            school_id: req.user.school_id,
            zone: req.user.zone || null,
            zone_id: req.user.zone_id || null,
            zone_name,
            title: req.user.title || null,
            can_act_independently: !!req.user.can_act_independently,
            school_name,
            moe_school_code,
            logo_url,
            academic_year,
            additional_role,
            is_registrar,
            is_recorder,
            avatar_url,
            id_photo_url,
            admin_full_name,
            registrar_signature_url
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

        // 2. Check if the teacher has an assignment matching this student,
        // OR an Academic-VP-approved request to enter marks for some
        // subject in this exact section (see subject_entry_requests) — a
        // homeroom teacher covering for an absent colleague may not have
        // any teacher_assignments row here at all otherwise.
        const [assignment] = await pool.query(
            'SELECT * FROM teacher_assignments WHERE teacher_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?',
            [req.user.user_id, student.class_level, student.section, student.stream, req.user.school_id]
        );
        let allowed = assignment.length > 0;
        if (!allowed) {
            const [approved] = await pool.query(
                `SELECT 1 FROM subject_entry_requests
                 WHERE teacher_id = ? AND school_id = ? AND class_level = ? AND section = ? AND stream = ? AND status = 'approved'`,
                [req.user.user_id, req.user.school_id, student.class_level, student.section, student.stream]
            );
            allowed = approved.length > 0;
        }

        res.json({ allowed });
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

// DASHBOARD: per-student performance for the "Student Performance" widget.
// This was previously missing entirely — the frontend has always called
// this exact path (see the comment above loadDashboardStudentPerformance
// in script.js), so the widget could never load anything before this.
// For every student this teacher is assigned to, average that student's
// marks (current term only, across just the subject(s) this teacher
// teaches to that student's class) and bucket into a tier so students who
// need attention surface first on the dashboard.
app.get('/api/teacher/student-performance', requireAuth, async (req, res) => {
    try {
        const currentTerm = await getCurrentTerm(req.user.school_id);

        const [assignments] = await pool.query(
            `SELECT DISTINCT subject_id, class_level, section, stream
             FROM teacher_assignments
             WHERE teacher_id = ? AND school_id = ?`,
            [req.user.user_id, req.user.school_id]
        );

        if (assignments.length === 0) {
            return res.json({ students: [] });
        }

        // Group the subjects this teacher teaches by which section they
        // teach them to, since a teacher can teach different subjects to
        // different sections.
        const subjectsBySection = {};
        assignments.forEach(a => {
            const key = `${a.class_level}|${a.section}|${a.stream}`;
            if (!subjectsBySection[key]) subjectsBySection[key] = [];
            subjectsBySection[key].push(a.subject_id);
        });
        const sectionKeys = Object.keys(subjectsBySection);

        const sectionClause = sectionKeys.map(() => '(class_level = ? AND section = ? AND stream = ?)').join(' OR ');
        const sectionParams = [];
        sectionKeys.forEach(key => sectionParams.push(...key.split('|')));

        const [students] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name, class_level, section, stream
             FROM students
             WHERE school_id = ? AND (${sectionClause})
             ORDER BY first_name, last_name`,
            [req.user.school_id, ...sectionParams]
        );

        const results = [];
        for (const student of students) {
            const key = `${student.class_level}|${student.section}|${student.stream}`;
            const subjectIds = subjectsBySection[key] || [];
            if (subjectIds.length === 0) continue;

            const [[{ avg_score }]] = await pool.query(
                `SELECT AVG(score) as avg_score FROM marks
                 WHERE student_id = ? AND school_id = ? AND term = ? AND subject_id IN (${subjectIds.map(() => '?').join(',')})`,
                [student.student_id, req.user.school_id, currentTerm, ...subjectIds]
            );

            let tier, average_score;
            if (avg_score == null) {
                tier = 'none';
                average_score = null;
            } else {
                average_score = Math.round(Number(avg_score) * 100) / 100;
                if (average_score >= 75) tier = 'good';
                else if (average_score >= 50) tier = 'average';
                else tier = 'poor';
            }

            results.push({
                student_id: student.student_id,
                full_name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' '),
                average_score,
                tier
            });
        }

        res.json({ students: results });
    } catch (err) {
        console.error("student-performance error:", err);
        res.status(500).json({ error: "Could not load student performance" });
    }
});


// =========================================================================
// EXECUTIVE SCHOOL ADMINISTRATION SUITE — additions below
// Five gaps closed against the spec: (1) Teacher Setup + Assignment
// (Stage 1 Principal hire, Stage 2 Academic VP load assignment),
// (2) Principal's Teacher Performance & Red-Flag Audit widget,
// (3) school_admins' own Digital Signature/Stamp upload,
// (4) Universal Contact & Messaging Hub, (5) Academic VP's Mark Cut-Off
// Configuration. Each follows the existing file's conventions: a
// migration comment where a new table/column is needed, requireAdminTitle
// for RBAC, and school_id scoping on every query.
// =========================================================================

// --- (1) Teacher Setup, Stage 1a: incoming teachers pushed by Zonal ---
// The zonal-recruitment-code path from the spec now works like this:
// zonal registers the teacher on their end and pushes them to this
// school (POST /api/zonal/teachers, or a Development Coordinator's proposal once Head
// of Education approves it) — landing here as a pending row. Nothing in
// `teachers` exists yet and nobody can log in yet; the Principal reviews
// the queue and either accepts (which mints the real Teacher ID and sets
// the login credentials, i.e. does the "core credentials" part of Stage
// 1 from the spec) or declines (e.g. wrong school, duplicate, changed
// mind). Only ever this school's own queue — school_id is always taken
// from the Principal's own token, never from the request.
app.get('/api/principal/incoming-teachers', requireAuth, requirePrincipal, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT incoming_id, first_name, middle_name, last_name, contact_number, email,
                    zonal_recruitment_code, status, teacher_id, decline_reason, created_at
             FROM incoming_teachers
             WHERE school_id = ?
             ORDER BY (status = 'pending') DESC, created_at DESC`,
            [req.user.school_id]
        );
        res.json(rows.map(r => ({
            ...r,
            full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ')
        })));
    } catch (err) {
        console.error("/api/principal/incoming-teachers GET error:", err);
        res.status(500).json({ error: "Could not load incoming teachers" });
    }
});

app.post('/api/principal/incoming-teachers/:id/accept', requireAuth, requirePrincipal, async (req, res) => {
    const { password, contact_number, email } = req.body;
    if (!password) return res.status(400).json({ error: "A login password is required to activate this teacher's account." });
    try {
        const [rows] = await pool.query(
            `SELECT * FROM incoming_teachers WHERE incoming_id = ? AND school_id = ? AND status = 'pending'`,
            [req.params.id, req.user.school_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Incoming teacher not found or already decided." });
        const incoming = rows[0];

        const teacher_id = await createTeacherAccount({
            school_id: req.user.school_id,
            first_name: incoming.first_name,
            middle_name: incoming.middle_name,
            last_name: incoming.last_name,
            contact_number: contact_number || incoming.contact_number,
            email: email || incoming.email,
            password
        });

        await pool.query(
            `UPDATE incoming_teachers SET status = 'accepted', teacher_id = ?, decided_by = ?, decided_at = NOW() WHERE incoming_id = ?`,
            [teacher_id, req.user.user_id, incoming.incoming_id]
        );
        res.json({ message: "Teacher accepted and activated. Academic VP can now assign their teaching load.", teacher_id });
    } catch (err) {
        console.error("/api/principal/incoming-teachers/:id/accept error:", err);
        res.status(err.status || 500).json({ error: err.status ? err.message : "Could not accept incoming teacher" });
    }
});

app.post('/api/principal/incoming-teachers/:id/decline', requireAuth, requirePrincipal, async (req, res) => {
    const { reason } = req.body;
    try {
        const [result] = await pool.query(
            `UPDATE incoming_teachers SET status = 'declined', decline_reason = ?, decided_by = ?, decided_at = NOW()
             WHERE incoming_id = ? AND school_id = ? AND status = 'pending'`,
            [reason || null, req.user.user_id, req.params.id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Incoming teacher not found or already decided." });
        res.json({ message: "Incoming teacher declined." });
    } catch (err) {
        console.error("/api/principal/incoming-teachers/:id/decline error:", err);
        res.status(500).json({ error: "Could not decline incoming teacher" });
    }
});

// --- (1) Teacher Setup, Stage 1b: Principal direct local hire ---
// REMOVED — school admins are not permitted to hire teachers locally.
// Every teacher must come through the Zonal push-and-accept path above
// (see /api/principal/incoming-teachers/:id/accept). createTeacherAccount
// is still used by that path.


// Shared roster view for both sides of the Stage 1 -> Stage 2 handoff:
// Principal just finished onboarding, Academic VP is about to assign
// teaching loads, Admin VP needs the same list for attendance/textbooks.
// assignment_count / awaiting_assignment let the UI flag "still needs
// Academic VP" without a second round trip.
app.get('/api/admin/teachers', requireAuth, requireAdminTitle('Principal', 'Academic VP', 'Admin VP'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT t.teacher_id, t.first_name, t.middle_name, t.last_name, t.contact_number, t.email,
                    t.homeroom_class_level, t.homeroom_section, t.homeroom_stream, t.is_registrar,
                    COUNT(DISTINCT ta.subject_id, ta.class_level, ta.section) AS assignment_count
             FROM teachers t
             LEFT JOIN teacher_assignments ta ON ta.teacher_id = t.teacher_id AND ta.school_id = t.school_id
             WHERE t.school_id = ?
             GROUP BY t.teacher_id
             ORDER BY t.first_name, t.last_name`,
            [req.user.school_id]
        );
        res.json(rows.map(r => ({
            teacher_id: r.teacher_id,
            full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '),
            contact_number: r.contact_number,
            email: r.email,
            homeroom: r.homeroom_class_level ? { class_level: r.homeroom_class_level, section: r.homeroom_section, stream: r.homeroom_stream } : null,
            assignment_count: Number(r.assignment_count),
            awaiting_assignment: Number(r.assignment_count) === 0,
            is_registrar: !!r.is_registrar
        })));
    } catch (err) {
        console.error("/api/admin/teachers error:", err);
        res.status(500).json({ error: "Could not load teacher roster" });
    }
});

// --- (1) Teacher Setup, Stage 2: Academic VP teaching-load assignment ---
// teacher_assignments already exists and is READ elsewhere in this file
// (performance, timetable, marks-review) — this is the write side.
// Requires this migration if the table doesn't already have these
// columns:
//   CREATE TABLE IF NOT EXISTS teacher_assignments (
//     teacher_id VARCHAR(50) NOT NULL,
//     school_id INT NOT NULL,
//     class_level VARCHAR(20) NOT NULL,
//     section VARCHAR(10) NOT NULL,
//     stream VARCHAR(50) NULL,
//     subject_id VARCHAR(50) NOT NULL,
//     assigned_by VARCHAR(50) NULL,
//     assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     UNIQUE KEY uq_teacher_assignment (teacher_id, school_id, class_level, section, subject_id)
//   );
// Deliberately not assuming a numeric primary key on this pre-existing
// table (it's never inserted/deleted anywhere else in this file, so we
// don't know if one exists) — delete below matches on the natural key
// instead of an assignment_id.
app.get('/api/academic-vp/teacher-assignments', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { teacher_id } = req.query;
    try {
        let query = `SELECT ta.teacher_id, ta.class_level, ta.section, ta.stream, ta.subject_id,
                            s.subject_name, t.first_name, t.last_name
                     FROM teacher_assignments ta
                     JOIN subjects s ON s.subject_id = ta.subject_id AND s.school_id = ta.school_id
                     JOIN teachers t ON t.teacher_id = ta.teacher_id AND t.school_id = ta.school_id
                     WHERE ta.school_id = ?`;
        const params = [req.user.school_id];
        if (teacher_id) { query += ' AND ta.teacher_id = ?'; params.push(teacher_id); }
        query += ' ORDER BY t.first_name, ta.class_level, ta.section';
        const [rows] = await pool.query(query, params);
        res.json(rows.map(r => ({
            teacher_id: r.teacher_id,
            teacher_name: [r.first_name, r.last_name].filter(Boolean).join(' '),
            class_level: r.class_level,
            section: r.section,
            stream: r.stream,
            subject_id: r.subject_id,
            subject_name: r.subject_name
        })));
    } catch (err) {
        console.error("/api/academic-vp/teacher-assignments GET error:", err);
        res.status(500).json({ error: "Could not load teaching assignments" });
    }
});

app.post('/api/academic-vp/teacher-assignments', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { teacher_id, class_level, section, stream, subject_id } = req.body;
    if (!teacher_id || !class_level || !section || !subject_id) {
        return res.status(400).json({ error: "teacher_id, class_level, section, and subject_id are required" });
    }
    try {
        const [teacherRows] = await pool.query('SELECT teacher_id FROM teachers WHERE teacher_id = ? AND school_id = ?', [teacher_id, req.user.school_id]);
        if (teacherRows.length === 0) return res.status(404).json({ error: "Teacher not found in your school." });

        await pool.query(
            `INSERT INTO teacher_assignments (teacher_id, school_id, class_level, section, stream, subject_id, assigned_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE stream = VALUES(stream), assigned_by = VALUES(assigned_by), assigned_at = NOW()`,
            [teacher_id, req.user.school_id, class_level, section, stream || null, subject_id, req.user.user_id]
        );
        res.json({ message: "Teaching assignment saved." });
    } catch (err) {
        console.error("/api/academic-vp/teacher-assignments POST error:", err);
        res.status(500).json({ error: "Could not save teaching assignment" });
    }
});

app.delete('/api/academic-vp/teacher-assignments', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { teacher_id, class_level, section, subject_id } = req.body;
    if (!teacher_id || !class_level || !section || !subject_id) {
        return res.status(400).json({ error: "teacher_id, class_level, section, and subject_id are required" });
    }
    try {
        const [result] = await pool.query(
            `DELETE FROM teacher_assignments WHERE teacher_id = ? AND school_id = ? AND class_level = ? AND section = ? AND subject_id = ?`,
            [teacher_id, req.user.school_id, class_level, section, subject_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Assignment not found." });
        res.json({ message: "Assignment removed." });
    } catch (err) {
        console.error("/api/academic-vp/teacher-assignments DELETE error:", err);
        res.status(500).json({ error: "Could not remove assignment" });
    }
});

// --- (1) Teacher Setup, Stage 2b: Academic VP homeroom assignment ---
// The other half of "instructional placement" the spec gives Academic
// VP alongside subject/class assignments above: naming a teacher the
// homeroom teacher for one class/section/stream. Writes straight to the
// teachers row (homeroom_class_level/section/stream — already read
// everywhere else in this file, e.g. getHomeroomSectionOrNull) rather
// than a join table, since a teacher can only be homeroom for one
// section at a time and a section can only have one homeroom teacher.
app.post('/api/academic-vp/homeroom', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { teacher_id, class_level, section, stream } = req.body;
    if (!teacher_id || !class_level || !section) {
        return res.status(400).json({ error: "teacher_id, class_level, and section are required" });
    }
    try {
        const [teacherRows] = await pool.query('SELECT teacher_id FROM teachers WHERE teacher_id = ? AND school_id = ?', [teacher_id, req.user.school_id]);
        if (teacherRows.length === 0) return res.status(404).json({ error: "Teacher not found in your school." });

        const [existingRows] = await pool.query(
            `SELECT teacher_id FROM teachers
             WHERE school_id = ? AND homeroom_class_level = ? AND homeroom_section = ? AND homeroom_stream <=> ? AND teacher_id != ?`,
            [req.user.school_id, class_level, section, stream || null, teacher_id]
        );
        if (existingRows.length > 0) {
            return res.status(409).json({ error: "This class/section already has a different homeroom teacher. Remove them first." });
        }

        await pool.query(
            `UPDATE teachers SET homeroom_class_level = ?, homeroom_section = ?, homeroom_stream = ? WHERE teacher_id = ? AND school_id = ?`,
            [class_level, section, stream || null, teacher_id, req.user.school_id]
        );
        res.json({ message: "Homeroom assigned." });
    } catch (err) {
        console.error("/api/academic-vp/homeroom POST error:", err);
        res.status(500).json({ error: "Could not assign homeroom" });
    }
});

app.delete('/api/academic-vp/homeroom', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { teacher_id } = req.body;
    if (!teacher_id) return res.status(400).json({ error: "teacher_id is required" });
    try {
        const [result] = await pool.query(
            `UPDATE teachers SET homeroom_class_level = NULL, homeroom_section = NULL, homeroom_stream = NULL
             WHERE teacher_id = ? AND school_id = ?`,
            [teacher_id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Teacher not found in your school." });
        res.json({ message: "Homeroom assignment removed." });
    } catch (err) {
        console.error("/api/academic-vp/homeroom DELETE error:", err);
        res.status(500).json({ error: "Could not remove homeroom assignment" });
    }
});

// --- (1) Teacher Setup, Stage 2c: Academic VP grants the additional Registrar role ---
// Alongside a teaching load or a homeroom, the spec lets Academic VP
// hand a teacher the additional Registrar role. This is a flag on the
// teacher's OWN existing row (teachers.is_registrar) — same login, no
// separate account or password — exactly like how a Recorder already
// works via the teachers.is_recorder flag (see requireRegistrarOrRecorder
// above). requireRegistrarOnly/requireRegistrarOrRecorder both already
// recognize this flag, so a flag-granted Registrar can immediately use
// every existing Registrar-only screen (Recorder management, Transfer
// Navigation Hub, textbooks, graduation, etc.) with no other change.
//
// ADD THESE if they don't exist yet:
//   ALTER TABLE teachers
//     ADD COLUMN is_registrar TINYINT(1) NOT NULL DEFAULT 0,
//     ADD COLUMN registrar_assigned_by VARCHAR(50) NULL,
//     ADD COLUMN registrar_assigned_at DATETIME NULL;
app.post('/api/academic-vp/grant-registrar', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { teacher_id } = req.body;
    if (!teacher_id) return res.status(400).json({ error: "teacher_id is required" });
    try {
        const [result] = await pool.query(
            `UPDATE teachers SET is_registrar = 1, registrar_assigned_by = ?, registrar_assigned_at = NOW()
             WHERE teacher_id = ? AND school_id = ? AND (is_registrar IS NULL OR is_registrar = 0)`,
            [req.user.user_id, teacher_id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(409).json({ error: "Teacher not found in your school, or already a Registrar." });
        res.json({ message: "Registrar role granted. They keep using their existing teacher login." });
    } catch (err) {
        console.error("/api/academic-vp/grant-registrar error:", err);
        res.status(500).json({ error: "Could not grant Registrar role" });
    }
});

app.delete('/api/academic-vp/grant-registrar', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const { teacher_id } = req.body;
    if (!teacher_id) return res.status(400).json({ error: "teacher_id is required" });
    try {
        const [result] = await pool.query(
            `UPDATE teachers SET is_registrar = 0, registrar_assigned_by = NULL, registrar_assigned_at = NULL
             WHERE teacher_id = ? AND school_id = ?`,
            [teacher_id, req.user.school_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Teacher not found in your school." });
        res.json({ message: "Registrar role removed." });
    } catch (err) {
        console.error("/api/academic-vp/grant-registrar DELETE error:", err);
        res.status(500).json({ error: "Could not remove Registrar role" });
    }
});

// --- (5) Academic VP: school-wide passing mark cut-off ---
// Same school_settings key/value pattern as current_term/term_start_date
// above. Read by Academic VP + Principal (below-cutoff review, red-flag
// audit) and advisory-linked into the Registrar's promotion screen;
// written only by Academic VP.
async function getPassMarkCutoff(school_id) {
    const [rows] = await pool.query(
        "SELECT setting_value FROM school_settings WHERE setting_key = 'pass_mark_cutoff' AND school_id = ?",
        [school_id]
    );
    return rows.length > 0 ? Number(rows[0].setting_value) : 50; // 50% default until Academic VP publishes one
}

app.get('/api/academic-vp/mark-cutoff', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    try {
        res.json({ cutoff: await getPassMarkCutoff(req.user.school_id) });
    } catch (err) {
        console.error("/api/academic-vp/mark-cutoff GET error:", err);
        res.status(500).json({ error: "Could not load the passing cut-off" });
    }
});

app.post('/api/academic-vp/mark-cutoff', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    const value = Number(req.body.cutoff);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
        return res.status(400).json({ error: "cutoff must be a number between 0 and 100" });
    }
    try {
        await pool.query(
            `INSERT INTO school_settings (setting_key, setting_value, school_id) VALUES ('pass_mark_cutoff', ?, ?)
             ON DUPLICATE KEY UPDATE setting_value = ?`,
            [String(value), req.user.school_id, String(value)]
        );
        res.json({ message: `Passing cut-off published at ${value}%.`, cutoff: value });
    } catch (err) {
        console.error("/api/academic-vp/mark-cutoff POST error:", err);
        res.status(500).json({ error: "Could not publish the passing cut-off" });
    }
});

// Every student's year average against the published cutoff, reusing
// the exact same year_average computation the school leaderboard uses
// (both semesters synced to the homeroom's pushed report). Advisory
// only — doesn't move anyone's class_level; the Registrar still does
// that via PUT /api/promote/:id (see the cutoff note added there).
app.get('/api/academic-vp/below-cutoff', requireAuth, requireAdminTitle('Academic VP'), async (req, res) => {
    try {
        const cutoff = await getPassMarkCutoff(req.user.school_id);
        const leaderboard = await getSchoolYearLeaderboard(req.user.school_id);
        const below = leaderboard.filter(l => l.year_average < cutoff);
        if (below.length === 0) return res.json({ cutoff, students: [] });

        const [studentRows] = await pool.query(
            `SELECT student_id, first_name, middle_name, last_name FROM students WHERE school_id = ? AND student_id IN (?)`,
            [req.user.school_id, below.map(b => b.student_id)]
        );
        const namesById = new Map(studentRows.map(s => [String(s.student_id), [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ')]));

        res.json({
            cutoff,
            students: below
                .map(b => ({ ...b, full_name: namesById.get(String(b.student_id)) || null }))
                .sort((a, b) => a.year_average - b.year_average)
        });
    } catch (err) {
        console.error("/api/academic-vp/below-cutoff error:", err);
        res.status(500).json({ error: "Could not load students below the cut-off" });
    }
});

// --- (2) Principal: Teacher Performance & Red-Flag Audit ---
// Flags a teacher if ANY of: excessive absences (teacher_attendance,
// trailing 30 days), poor teaching-period punctuality
// (period_attendance_log, trailing 30 days), or their students' average
// score sits below the Academic VP's published cut-off for the current
// term. Computed as a handful of GROUP BY aggregates rather than looping
// per-teacher, since a school's whole staff is being scanned at once.
const RED_FLAG_ABSENCE_DAYS = 3;      // >=3 absent days in the last 30 flags
const RED_FLAG_PUNCTUALITY_PCT = 70;  // punctuality rate below this flags

// Academic VP shares this same audit view as the Principal — the Academic
// VP needs it to check a teacher's attendance/teaching-punctuality record
// before deciding a subject-entry request (see subject_entry_requests
// below), not just after the fact like the Principal's use of it.
app.get('/api/principal/teacher-audit', requireAuth, requireAdminTitle('Principal', 'Academic VP'), async (req, res) => {
    try {
        const since = toDateOnly(new Date(Date.now() - 30 * 86400000));
        const cutoff = await getPassMarkCutoff(req.user.school_id);
        const currentTerm = await getCurrentTerm(req.user.school_id);

        const [teachers] = await pool.query(
            `SELECT teacher_id, first_name, last_name FROM teachers WHERE school_id = ?`,
            [req.user.school_id]
        );
        if (teachers.length === 0) return res.json({ cutoff, current_term: currentTerm, teachers: [] });

        const [absenceRows] = await pool.query(
            `SELECT teacher_id, COUNT(*) AS absent_days FROM teacher_attendance
             WHERE school_id = ? AND status = 'absent' AND attendance_date >= ?
             GROUP BY teacher_id`,
            [req.user.school_id, since]
        );
        const absenceByTeacher = new Map(absenceRows.map(r => [r.teacher_id, Number(r.absent_days)]));

        const [punctualityRows] = await pool.query(
            `SELECT ct.teacher_id,
                    SUM(pal.teacher_present) AS present_count,
                    COUNT(*) AS total_count
             FROM period_attendance_log pal
             JOIN class_timetable ct ON ct.timetable_id = pal.timetable_id
             WHERE pal.school_id = ? AND pal.log_date >= ?
             GROUP BY ct.teacher_id`,
            [req.user.school_id, since]
        );
        const punctualityByTeacher = new Map(punctualityRows.map(r => [r.teacher_id, r.total_count ? Math.round((Number(r.present_count) / Number(r.total_count)) * 100) : null]));

        const [scoreRows] = await pool.query(
            `SELECT ta.teacher_id, AVG(m.score) AS avg_score
             FROM teacher_assignments ta
             JOIN marks m ON m.subject_id = ta.subject_id AND m.school_id = ta.school_id AND m.term = ?
             WHERE ta.school_id = ?
             GROUP BY ta.teacher_id`,
            [currentTerm, req.user.school_id]
        );
        const scoreByTeacher = new Map(scoreRows.map(r => [r.teacher_id, Math.round(Number(r.avg_score) * 100) / 100]));

        const audit = teachers.map(t => {
            const absent_days_30d = absenceByTeacher.get(t.teacher_id) || 0;
            const punctuality_rate = punctualityByTeacher.has(t.teacher_id) ? punctualityByTeacher.get(t.teacher_id) : null;
            const avg_score = scoreByTeacher.has(t.teacher_id) ? scoreByTeacher.get(t.teacher_id) : null;

            const flags = [];
            if (absent_days_30d >= RED_FLAG_ABSENCE_DAYS) flags.push('excessive_absences');
            if (punctuality_rate !== null && punctuality_rate < RED_FLAG_PUNCTUALITY_PCT) flags.push('teaching_discipline');
            if (avg_score !== null && avg_score < cutoff) flags.push('low_performance');

            return {
                teacher_id: t.teacher_id,
                full_name: [t.first_name, t.last_name].filter(Boolean).join(' '),
                absent_days_30d,
                punctuality_rate,
                avg_score,
                flagged: flags.length > 0,
                flags
            };
        });

        res.json({ cutoff, current_term: currentTerm, teachers: audit.sort((a, b) => b.flags.length - a.flags.length) });
    } catch (err) {
        console.error("/api/principal/teacher-audit error:", err);
        res.status(500).json({ error: "Could not load the teacher audit" });
    }
});

// Detail view for the audit widget's modal — full attendance log,
// punctuality periods, and per-subject/per-term score breakdown, for one
// teacher.
app.get('/api/principal/teacher-audit/:teacher_id', requireAuth, requireAdminTitle('Principal', 'Academic VP'), async (req, res) => {
    const { teacher_id } = req.params;
    try {
        const [teacherRows] = await pool.query('SELECT teacher_id, first_name, last_name FROM teachers WHERE teacher_id = ? AND school_id = ?', [teacher_id, req.user.school_id]);
        if (teacherRows.length === 0) return res.status(404).json({ error: "Teacher not found in your school." });

        const since = toDateOnly(new Date(Date.now() - 30 * 86400000));

        const [attendance] = await pool.query(
            `SELECT attendance_date, status FROM teacher_attendance
             WHERE teacher_id = ? AND school_id = ? AND attendance_date >= ? ORDER BY attendance_date DESC`,
            [teacher_id, req.user.school_id, since]
        );

        const [periods] = await pool.query(
            `SELECT pal.log_date, pal.teacher_present, s.subject_name, ct.class_level, ct.section, ct.stream
             FROM period_attendance_log pal
             JOIN class_timetable ct ON ct.timetable_id = pal.timetable_id
             JOIN subjects s ON s.subject_id = ct.subject_id AND s.school_id = ct.school_id
             WHERE pal.school_id = ? AND ct.teacher_id = ? AND pal.log_date >= ?
             ORDER BY pal.log_date DESC`,
            [req.user.school_id, teacher_id, since]
        );
        const present_periods = periods.filter(p => p.teacher_present).length;

        const [scores] = await pool.query(
            `SELECT ta.subject_id, s.subject_name, m.term, AVG(m.score) AS avg_score
             FROM teacher_assignments ta
             JOIN subjects s ON s.subject_id = ta.subject_id AND s.school_id = ta.school_id
             JOIN marks m ON m.subject_id = ta.subject_id AND m.school_id = ta.school_id
             WHERE ta.teacher_id = ? AND ta.school_id = ?
             GROUP BY ta.subject_id, m.term`,
            [teacher_id, req.user.school_id]
        );

        res.json({
            teacher_id,
            full_name: [teacherRows[0].first_name, teacherRows[0].last_name].filter(Boolean).join(' '),
            attendance_last_30d: attendance,
            absent_days_30d: attendance.filter(a => a.status === 'absent').length,
            punctuality: {
                total_periods: periods.length,
                present_periods,
                rate: periods.length ? Math.round((present_periods / periods.length) * 100) : null,
                periods
            },
            subject_scores: scores.map(s => ({ subject_id: s.subject_id, subject_name: s.subject_name, term: s.term, avg_score: Math.round(Number(s.avg_score) * 100) / 100 }))
        });
    } catch (err) {
        console.error("/api/principal/teacher-audit/:teacher_id error:", err);
        res.status(500).json({ error: "Could not load teacher detail" });
    }
});

// --- (3) Digital Signature Suite: school_admins' own signature/stamp ---
// Unlike a teacher's signature (which needs Principal approval — see
// submitTeacherDocumentRequest above), a school_admins account IS the
// approving authority, so this is a direct self-serve upload with no
// review step — same pattern as /api/teacher/update-avatar.
// Requires these columns if they don't exist yet:
//   ALTER TABLE school_admins ADD COLUMN signature_url VARCHAR(255) NULL, ADD COLUMN stamp_url VARCHAR(255) NULL, ADD COLUMN avatar_url VARCHAR(255) NULL, ADD COLUMN id_photo_url VARCHAR(255) NULL;
async function uploadAdminDocument(req, res, column, fieldName) {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (!req.file.mimetype.startsWith('image/')) {
        fs.unlink(req.file.path, () => { });
        return res.status(400).json({ error: `${fieldName} must be an image file (JPEG or PNG).` });
    }
    const converted = await convertHeicIfNeeded(req.file);
    if (converted) req.file = converted;

    const filePath = `/uploads/${req.file.filename}`;
    await pool.query(`UPDATE school_admins SET ${column} = ? WHERE admin_id = ? AND school_id = ?`, [filePath, req.user.user_id, req.user.school_id]);
    res.json({ [column]: filePath });
}

app.post('/api/admin/upload-signature', requireAuth, requireRole('school_admins'), handleUploadError(upload.single('signature')), async (req, res) => {
    try {
        await uploadAdminDocument(req, res, 'signature_url', 'Signature');
    } catch (err) {
        console.error("/api/admin/upload-signature error:", err);
        res.status(500).json({ error: "Could not upload signature" });
    }
});

app.post('/api/admin/upload-stamp', requireAuth, requireRole('school_admins'), handleUploadError(upload.single('stamp')), async (req, res) => {
    try {
        await uploadAdminDocument(req, res, 'stamp_url', 'Stamp');
    } catch (err) {
        console.error("/api/admin/upload-stamp error:", err);
        res.status(500).json({ error: "Could not upload stamp" });
    }
});

// Profile picture — same self-serve pattern as signature/stamp, just a
// different column, so it can render in the sidebar/top-bar avatar circle
// instead of the "--" initials fallback.
app.post('/api/admin/upload-avatar', requireAuth, requireRole('school_admins'), handleUploadError(upload.single('avatar')), async (req, res) => {
    try {
        await uploadAdminDocument(req, res, 'avatar_url', 'Profile picture');
    } catch (err) {
        console.error("/api/admin/upload-avatar error:", err);
        res.status(500).json({ error: "Could not upload profile picture" });
    }
});

// ID card photo — deliberately a separate column/upload from avatar_url.
// avatar_url is the casual portrait shown in the sidebar/topbar; schools
// need the printed ID card to carry a specific, often more formal photo
// (passport-style, plain background, etc.) that an admin may not want as
// their everyday in-app avatar. Same direct self-serve pattern as
// signature/stamp/avatar above (no approval step, since this account IS
// the approving authority for its own school).
app.post('/api/admin/upload-id-photo', requireAuth, requireRole('school_admins'), handleUploadError(upload.single('id_photo')), async (req, res) => {
    try {
        await uploadAdminDocument(req, res, 'id_photo_url', 'ID card photo');
    } catch (err) {
        console.error("/api/admin/upload-id-photo error:", err);
        res.status(500).json({ error: "Could not upload ID card photo" });
    }
});

app.get('/api/admin/document-status', requireAuth, requireRole('school_admins'), async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT signature_url, stamp_url, avatar_url, id_photo_url FROM school_admins WHERE admin_id = ? AND school_id = ?', [req.user.user_id, req.user.school_id]);
        const [schoolRows] = await pool.query('SELECT school_seal_url FROM schools WHERE id = ?', [req.user.school_id]);
        res.json({
            signature_url: rows[0]?.signature_url || null,
            stamp_url: rows[0]?.stamp_url || null,
            avatar_url: rows[0]?.avatar_url || null,
            id_photo_url: rows[0]?.id_photo_url || null,
            school_seal_url: schoolRows[0]?.school_seal_url || null
        });
    } catch (err) {
        console.error("/api/admin/document-status error:", err);
        res.status(500).json({ error: "Could not load document status" });
    }
});

// School Seal — distinct from the Principal Stamp above: the stamp is
// tied to whichever admin uploaded it (school_admins.stamp_url, one per
// person), while the seal is a single school-wide asset stored on the
// schools row itself, so it's the same image for every admin who views
// or prints a document, regardless of who's logged in. Only the
// Principal can change it — everyone else gets a read-only preview (see
// the CURRENT_TITLE check in the profile page's loadDocumentStatus()).
// Requires this column if it doesn't exist yet:
//   ALTER TABLE schools ADD COLUMN school_seal_url VARCHAR(255) NULL;
app.post('/api/admin/upload-school-seal', requireAuth, requireAdminTitle('Principal'), handleUploadError(upload.single('school_seal')), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        if (!req.file.mimetype.startsWith('image/')) {
            fs.unlink(req.file.path, () => { });
            return res.status(400).json({ error: "School seal must be an image file (JPEG or PNG)." });
        }
        const converted = await convertHeicIfNeeded(req.file);
        if (converted) req.file = converted;

        const filePath = `/uploads/${req.file.filename}`;
        await pool.query(`UPDATE schools SET school_seal_url = ? WHERE id = ?`, [filePath, req.user.school_id]);
        res.json({ school_seal_url: filePath });
    } catch (err) {
        console.error("/api/admin/upload-school-seal error:", err);
        res.status(500).json({ error: "Could not upload school seal" });
    }
});

// --- (4) Universal Contact & Messaging Hub ---
// One table covers all three tiers from the spec: Teacher Messaging
// (school_admins <-> teachers), Zonal Admin Bridge (upward escalation to
// Zonal Admin), and Inter-Admin routing (Principal <-> Admin VP <->
// Academic VP within the same school). Scoped throughout by school_id so
// one school's messages never leak into another's.
//
// Requires a new table if it doesn't exist yet:
//   CREATE TABLE admin_messages (
//     message_id INT AUTO_INCREMENT PRIMARY KEY,
//     school_id INT NOT NULL,
//     sender_type ENUM('school_admins','teachers','zonal_admins') NOT NULL,
//     sender_id VARCHAR(50) NOT NULL,
//     recipient_type ENUM('school_admins','teachers','zonal_admins') NOT NULL,
//     recipient_id VARCHAR(50) NOT NULL,
//     subject VARCHAR(150) NULL,
//     body TEXT NOT NULL,
//     is_read TINYINT(1) NOT NULL DEFAULT 0,
//     sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
//     INDEX idx_recipient (school_id, recipient_type, recipient_id),
//     INDEX idx_sender (school_id, sender_type, sender_id)
//   );
// Only the school_admins side (sender) is wired up here — a matching
// inbox GET for teachers/zonal_admins would live in those portals' own
// route files, but the schema is already shaped for it.

// Recipients for the compose UI: every teacher and every other
// school_admins account in this admin's own school, plus (if the school
// is assigned to a zone) that zone's Head of Education as the standing
// "Zonal Admin Bridge" contact.
app.get('/api/admin/messages/recipients', requireAuth, requireRole('school_admins'), async (req, res) => {
    try {
        const [teachers] = await pool.query(
            `SELECT teacher_id AS id, first_name, last_name FROM teachers WHERE school_id = ?`,
            [req.user.school_id]
        );
        const [admins] = await pool.query(
            `SELECT admin_id AS id, first_name, last_name, title FROM school_admins WHERE school_id = ? AND admin_id != ?`,
            [req.user.school_id, req.user.user_id]
        );
        const [schoolRows] = await pool.query('SELECT zone_id FROM schools WHERE id = ?', [req.user.school_id]);
        let zonal_contact = null;
        if (schoolRows[0]?.zone_id) {
            const [zonalRows] = await pool.query(
                `SELECT admin_id AS id, first_name, last_name FROM zonal_admins WHERE zone_id = ? AND title = 'Head of Education' LIMIT 1`,
                [schoolRows[0].zone_id]
            );
            if (zonalRows.length > 0) zonal_contact = { id: zonalRows[0].id, full_name: [zonalRows[0].first_name, zonalRows[0].last_name].filter(Boolean).join(' ') };
        }

        res.json({
            teachers: teachers.map(t => ({ id: t.id, full_name: [t.first_name, t.last_name].filter(Boolean).join(' ') })),
            admins: admins.map(a => ({ id: a.id, full_name: [a.first_name, a.last_name].filter(Boolean).join(' '), title: a.title })),
            zonal_contact
        });
    } catch (err) {
        console.error("/api/admin/messages/recipients error:", err);
        res.status(500).json({ error: "Could not load recipients" });
    }
});

app.post('/api/admin/messages', requireAuth, requireRole('school_admins'), async (req, res) => {
    const { recipient_type, recipient_id, subject, body } = req.body;
    if (!['school_admins', 'teachers', 'zonal_admins'].includes(recipient_type) || !body?.trim()) {
        return res.status(400).json({ error: "recipient_type and body are required" });
    }
    try {
        let finalRecipientId = recipient_id || null;

        if (recipient_type === 'zonal_admins' && !finalRecipientId) {
            // Zonal Admin Bridge with no specific recipient chosen — route
            // to the zone's Head of Education by default.
            const [schoolRows] = await pool.query('SELECT zone_id FROM schools WHERE id = ?', [req.user.school_id]);
            if (!schoolRows[0]?.zone_id) return res.status(400).json({ error: "Your school isn't assigned to a zone yet, so there's no Zonal Admin to escalate to." });
            const [zonalRows] = await pool.query(
                `SELECT admin_id FROM zonal_admins WHERE zone_id = ? AND title = 'Head of Education' LIMIT 1`,
                [schoolRows[0].zone_id]
            );
            if (zonalRows.length === 0) return res.status(400).json({ error: "No Head of Education is set up for your zone yet." });
            finalRecipientId = zonalRows[0].admin_id;
        } else if (recipient_type !== 'zonal_admins' && !finalRecipientId) {
            return res.status(400).json({ error: "recipient_id is required for this recipient_type" });
        }

        // Confirm the recipient actually exists in-scope before writing —
        // a teacher/admin recipient must be in this admin's own school; a
        // zonal recipient just needs to exist (we already validated it
        // above if it was auto-picked as the Head of Education).
        if (recipient_type === 'teachers') {
            const [r] = await pool.query('SELECT teacher_id FROM teachers WHERE teacher_id = ? AND school_id = ?', [finalRecipientId, req.user.school_id]);
            if (r.length === 0) return res.status(404).json({ error: "Teacher not found in your school." });
        } else if (recipient_type === 'school_admins') {
            const [r] = await pool.query('SELECT admin_id FROM school_admins WHERE admin_id = ? AND school_id = ?', [finalRecipientId, req.user.school_id]);
            if (r.length === 0) return res.status(404).json({ error: "Admin not found in your school." });
        }

        await pool.query(
            `INSERT INTO admin_messages (school_id, sender_type, sender_id, recipient_type, recipient_id, subject, body)
             VALUES (?, 'school_admins', ?, ?, ?, ?, ?)`,
            [req.user.school_id, req.user.user_id, recipient_type, finalRecipientId, subject?.trim() || null, body.trim()]
        );
        res.json({ message: "Message sent." });
    } catch (err) {
        console.error("/api/admin/messages POST error:", err);
        res.status(500).json({ error: "Could not send message" });
    }
});

app.get('/api/admin/messages', requireAuth, requireRole('school_admins'), async (req, res) => {
    const box = req.query.box === 'sent' ? 'sent' : 'inbox';
    try {
        const [rows] = box === 'sent'
            ? await pool.query(
                `SELECT message_id, recipient_type, recipient_id, subject, body, is_read, sent_at
                 FROM admin_messages WHERE school_id = ? AND sender_type = 'school_admins' AND sender_id = ?
                 ORDER BY sent_at DESC`,
                [req.user.school_id, req.user.user_id])
            : await pool.query(
                `SELECT message_id, sender_type, sender_id, subject, body, is_read, sent_at
                 FROM admin_messages WHERE school_id = ? AND recipient_type = 'school_admins' AND recipient_id = ?
                 ORDER BY sent_at DESC`,
                [req.user.school_id, req.user.user_id]);
        res.json(rows);
    } catch (err) {
        console.error("/api/admin/messages GET error:", err);
        res.status(500).json({ error: "Could not load messages" });
    }
});

app.post('/api/admin/messages/:id/read', requireAuth, requireRole('school_admins'), async (req, res) => {
    try {
        const [result] = await pool.query(
            `UPDATE admin_messages SET is_read = 1 WHERE message_id = ? AND school_id = ? AND recipient_type = 'school_admins' AND recipient_id = ?`,
            [req.params.id, req.user.school_id, req.user.user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Message not found." });
        res.json({ message: "Marked as read." });
    } catch (err) {
        console.error("/api/admin/messages/:id/read error:", err);
        res.status(500).json({ error: "Could not update message" });
    }
});

// ==========================================================
// Homeroom: mark a student as dropped out
// ==========================================================
// The only place students.status ever becomes 'Dropped' — needed so the
// Analysis Report below has a real "Drop Out" figure instead of having to
// infer it. Scoped the same way as /api/homeroom/reset-student-password:
// the caller must be a homeroom teacher, and the student must be in
// their own section. reason_category mirrors the two buckets on the
// Ministry's own paper form (academic-related vs family/home-related),
// plus 'other' for anything that isn't either.
//
// Requires these columns if they don't exist yet:
//   ALTER TABLE students
//     ADD COLUMN dropout_reason_category VARCHAR(20) NULL,
//     ADD COLUMN dropout_reason TEXT NULL,
//     ADD COLUMN dropped_at DATETIME NULL;
app.post('/api/homeroom/students/:student_id/mark-dropout', requireAuth, async (req, res) => {
    const { reason_category, reason } = req.body;
    if (!['academic', 'family', 'other'].includes(reason_category)) {
        return res.status(400).json({ error: "reason_category must be one of: academic, family, other." });
    }
    try {
        const homeroom = await getHomeroomSectionOrNull(req.user.user_id, req.user.school_id);
        if (!homeroom) return res.status(403).json({ error: "Only a homeroom teacher can mark a dropout." });

        const [studentRows] = await pool.query(
            'SELECT student_id FROM students WHERE student_id = ? AND class_level = ? AND section = ? AND stream = ? AND school_id = ?',
            [req.params.student_id, homeroom.class_level, homeroom.section, homeroom.stream, req.user.school_id]
        );
        if (studentRows.length === 0) return res.status(403).json({ error: "This student is not in your homeroom section." });

        await pool.query(
            `UPDATE students SET status = 'Dropped', dropout_reason_category = ?, dropout_reason = ?, dropped_at = NOW()
             WHERE student_id = ? AND school_id = ?`,
            [reason_category, reason || null, req.params.student_id, req.user.school_id]
        );
        res.json({ message: "Student marked as dropped out." });
    } catch (err) {
        console.error("/api/homeroom/students/:id/mark-dropout error:", err);
        res.status(500).json({ error: "Could not update this student's status" });
    }
});

// ==========================================================
// School-wide Semester/Yearly Analysis Report (for head office / zonal)
// ==========================================================
// Matches the Ministry-style "Result Analysis Form" (the template you
// shared): per class level, broken down by sex — Total Student, Drop
// Out, Tested/Examined, Incomplete, and score bands (0-49% / 50-74% /
// 75-100%), plus how many students hold class rank #1 (male/female).
//
// The source data doesn't cleanly separate these categories on its own,
// so these are the definitions this report applies:
//   - Total Student: every student on this school's roster at this
//     class level this year, excluding anyone who's transferred OUT
//     (status LIKE 'Transferred%') — a dropout still counts here.
//   - Drop Out: status = 'Dropped' (set only via POST
//     /api/homeroom/students/:id/mark-dropout above).
//   - Tested/Examined: has a computable overall average for the
//     requested term (or, for 'Year', a year average) — i.e. at least
//     one subject's marks were pushed for them.
//   - Incomplete: registered, not dropped, not tested —
//     Total - Drop Out - Tested, floored at 0.
//   - Score bands: among Tested students only, using the SAME
//     overallAverage()/yearAverage() computation as every other ranking
//     in this app, bucketed 0-49/50-74/75-100.
//   - Highest rank male/female: how many students hold class rank #1
//     (competition ranking, so a genuine tie means more than one) who
//     are male / female respectively.
async function getClassLevelAnalysisReport(school_id, term) {
    const [comboRows] = await pool.query(
        `SELECT DISTINCT class_level, section, stream FROM students
         WHERE school_id = ? AND status NOT LIKE 'Transferred%'`,
        [school_id]
    );

    const scoreByStudent = new Map();
    for (const combo of comboRows) {
        const rows = term === 'Year'
            ? await getSectionYearAverages(school_id, combo.class_level, combo.section, combo.stream)
            : await getSectionTermAverages(school_id, combo.class_level, combo.section, combo.stream, term);
        rows.forEach(r => { if (r.score != null) scoreByStudent.set(String(r.student_id), r.score); });
    }

    const [studentRows] = await pool.query(
        `SELECT student_id, class_level, sex, status FROM students
         WHERE school_id = ? AND status NOT LIKE 'Transferred%'`,
        [school_id]
    );

    const byLevel = {};
    const bucket = (level) => {
        if (!byLevel[level]) {
            byLevel[level] = {
                class_level: level,
                total: { Male: 0, Female: 0 }, dropout: { Male: 0, Female: 0 }, tested: { Male: 0, Female: 0 },
                band0_49: { Male: 0, Female: 0 }, band50_74: { Male: 0, Female: 0 }, band75_100: { Male: 0, Female: 0 },
                scores: []
            };
        }
        return byLevel[level];
    };

    studentRows.forEach(s => {
        // Any sex value other than 'Female' (unset, blank, etc.) is
        // counted as Male here so nobody silently falls out of Total —
        // a data-quality gap should surface as an odd M/F split, not a
        // Total that doesn't match the roster.
        const sex = s.sex === 'Female' ? 'Female' : 'Male';
        const b = bucket(s.class_level);
        b.total[sex]++;
        if (s.status === 'Dropped') b.dropout[sex]++;
        const score = scoreByStudent.get(String(s.student_id));
        if (score != null) {
            b.tested[sex]++;
            b.scores.push({ student_id: s.student_id, sex, score });
            if (score < 50) b.band0_49[sex]++;
            else if (score < 75) b.band50_74[sex]++;
            else b.band75_100[sex]++;
        }
    });

    const sumMF = (o) => o.Male + o.Female;
    const rows = Object.values(byLevel)
        .sort((a, b) => Number(a.class_level) - Number(b.class_level))
        .map(b => {
            const incomplete = {
                Male: Math.max(0, b.total.Male - b.dropout.Male - b.tested.Male),
                Female: Math.max(0, b.total.Female - b.dropout.Female - b.tested.Female)
            };
            const ranks = rankStudents(b.scores.map(s => ({ student_id: s.student_id, score: s.score })));
            const topRankStudents = b.scores.filter(s => ranks.get(String(s.student_id))?.rank === 1);
            return {
                class_level: b.class_level,
                total_student: { male: b.total.Male, female: b.total.Female, total: sumMF(b.total) },
                drop_out: { male: b.dropout.Male, female: b.dropout.Female, total: sumMF(b.dropout) },
                tested: { male: b.tested.Male, female: b.tested.Female, total: sumMF(b.tested) },
                incomplete: { male: incomplete.Male, female: incomplete.Female, total: incomplete.Male + incomplete.Female },
                band_0_49: { male: b.band0_49.Male, female: b.band0_49.Female, total: sumMF(b.band0_49) },
                band_50_74: { male: b.band50_74.Male, female: b.band50_74.Female, total: sumMF(b.band50_74) },
                band_75_100: { male: b.band75_100.Male, female: b.band75_100.Female, total: sumMF(b.band75_100) },
                highest_rank_male: topRankStudents.filter(s => s.sex === 'Male').length,
                highest_rank_female: topRankStudents.filter(s => s.sex === 'Female').length
            };
        });

    const totals = ['total_student', 'drop_out', 'tested', 'incomplete', 'band_0_49', 'band_50_74', 'band_75_100']
        .reduce((acc, key) => {
            acc[key] = { male: 0, female: 0, total: 0 };
            rows.forEach(r => { acc[key].male += r[key].male; acc[key].female += r[key].female; acc[key].total += r[key].total; });
            return acc;
        }, {
            class_level: 'Total',
            highest_rank_male: rows.reduce((n, r) => n + r.highest_rank_male, 0),
            highest_rank_female: rows.reduce((n, r) => n + r.highest_rank_female, 0)
        });

    return { rows, totals };
}

// Principal, Academic VP, and Admin VP can all VIEW the report; only the
// Principal generates the signed, printable PDF below (see the sign-strip
// on that route) — matches "he can print it out with school seal and
// name of principal and signature" from the spec.
app.get('/api/principal/analysis-report', requireAuth, requireAdminTitle('Principal', 'Academic VP', 'Admin VP'), async (req, res) => {
    const term = ['Semester 1', 'Semester 2', 'Year'].includes(req.query.term) ? req.query.term : 'Year';
    try {
        const report = await getClassLevelAnalysisReport(req.user.school_id, term);
        res.json({ term, ...report });
    } catch (err) {
        console.error("/api/principal/analysis-report error:", err);
        res.status(500).json({ error: "Could not build the analysis report" });
    }
});

// Fills a self-contained HTML page (no separate template file — this
// report doesn't need certificate.html's per-subject client-side script,
// just a straight table) with the class-level breakdown plus the
// Principal's printed name/signature and the school seal, the same
// buildSignatureHtml/buildSchoolSealHtml helpers every other printed
// document on this server uses.
function renderAnalysisReportHtml(data) {
    const CATS = ['total_student', 'drop_out', 'tested', 'incomplete', 'band_0_49', 'band_50_74', 'band_75_100'];
    const CAT_LABELS = ['Total Student', 'Drop Out', 'Tested/Examined', 'Incomplete', '0%-49%', '50%-74%', '75%-100%'];
    const rowHtml = (r, isTotal) => `
        <tr class="${isTotal ? 'totals-row' : ''}">
            <td>${escapeHtml(String(r.class_level))}</td>
            ${CATS.map(k => `<td>${r[k].male}</td><td>${r[k].female}</td><td>${r[k].total}</td>`).join('')}
            <td>${r.highest_rank_male}</td>
            <td>${r.highest_rank_female}</td>
        </tr>`;
    const bodyRows = data.rows.map(r => rowHtml(r, false)).join('') + rowHtml(data.totals, true);
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Analysis Report</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; margin:0; }
  h1 { text-align:center; font-size:16px; margin:0 0 2px; }
  .subhead { text-align:center; font-size:12px; margin-bottom:4px; color:#444; }
  table { width:100%; border-collapse: collapse; margin-top:12px; }
  th, td { border:1px solid #444; padding:4px 6px; text-align:center; }
  th { background:#f0f0f0; font-size:9.5px; }
  .totals-row { font-weight:bold; background:#f7f7f7; }
  .sign-strip { display:flex; justify-content:space-between; align-items:flex-end; margin-top:40px; }
  .sig-img { height:40px; display:block; margin:0 auto; }
  .seal-ring { width:70px; height:70px; border:2px dashed #999; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:9px; color:#999; }
  .seal-ring-img { border:none; }
  .seal-img { width:70px; height:70px; object-fit:contain; }
  .rule { border-top:1px solid #333; min-width:220px; margin-top:4px; padding-top:2px; font-size:10px; text-align:center; }
</style></head>
<body>
  <h1>${escapeHtml(data.school_name)}</h1>
  <div class="subhead">${escapeHtml([data.region, data.zone, data.woreda].filter(Boolean).join(' / '))}</div>
  <div class="subhead">Student Result Analysis &mdash; ${escapeHtml(data.term)} &middot; Generated ${escapeHtml(data.generated_on)}</div>
  <table>
    <thead>
      <tr>
        <th rowspan="2">Class Level</th>
        ${CAT_LABELS.map(l => `<th colspan="3">${l}</th>`).join('')}
        <th rowspan="2">Highest Rank Male</th><th rowspan="2">Highest Rank Female</th>
      </tr>
      <tr>${'<th>M</th><th>F</th><th>T</th>'.repeat(CATS.length)}</tr>
    </thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <div class="sign-strip">
    <div><div class="rule">Principal's Name: ${escapeHtml(data.principal_name || '')}</div></div>
    ${data.school_seal_html}
    <div style="text-align:center;">
      ${data.principal_signature_html}
      <div class="rule">Signature</div>
    </div>
  </div>
</body></html>`;
}

app.get('/api/principal/analysis-report/pdf', requireAuth, requirePrincipal, async (req, res) => {
    const term = ['Semester 1', 'Semester 2', 'Year'].includes(req.query.term) ? req.query.term : 'Year';
    try {
        const report = await getClassLevelAnalysisReport(req.user.school_id, term);
        const [[school]] = await pool.query(
            `SELECT sc.school_name, sc.school_seal_url, z.zone_name AS zone, w.woreda_name AS woreda, r.region_name AS region
             FROM schools sc LEFT JOIN zone z ON z.zone_id = sc.zone_id
             LEFT JOIN woreda w ON w.woreda_id = sc.woreda_id LEFT JOIN region r ON r.region_id = sc.region_id
             WHERE sc.id = ?`,
            [req.user.school_id]
        );
        const [[principal]] = await pool.query(
            `SELECT first_name, middle_name, last_name, signature_url FROM school_admins WHERE school_id = ? AND title = 'Principal' LIMIT 1`,
            [req.user.school_id]
        );
        const principalName = principal ? [principal.first_name, principal.middle_name, principal.last_name].filter(Boolean).join(' ') : '';

        const html = renderAnalysisReportHtml({
            school_name: school?.school_name || '', region: school?.region || '', zone: school?.zone || '', woreda: school?.woreda || '',
            term, generated_on: formatDualDateText(new Date()),
            rows: report.rows, totals: report.totals,
            principal_name: principalName,
            principal_signature_html: buildSignatureHtml(principal?.signature_url || null),
            school_seal_html: buildSchoolSealHtml(school?.school_seal_url || null)
        });

        const browser = await getBrowser();
        const page = await browser.newPage();
        page.on('pageerror', err => console.error("/api/principal/analysis-report/pdf render error:", err));
        try {
            await page.setContent(html, { waitUntil: 'networkidle0' });
            const pdfBuffer = await page.pdf({ printBackground: true, format: 'A4', landscape: true });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="Analysis-Report-${term.replace(/\s+/g, '-')}.pdf"`);
            res.send(pdfBuffer);
        } finally {
            await page.close();
        }
    } catch (err) {
        console.error("/api/principal/analysis-report/pdf error:", err);
        res.status(500).json({ error: "Could not generate the analysis report PDF" });
    }
});

// Zonal/head-office view — every school in the caller's zone (scoped via
// getZonalSchoolIds, same as /api/zonal/performance above), same shape
// as the Principal's own JSON view but one entry per school. Read-only:
// the zone doesn't print or sign this, it just reviews what each
// school's own Principal already generates/prints locally.
app.get('/api/zonal/analysis-reports', requireAuth, requireZonalAdmin, async (req, res) => {
    try {
        const schoolIds = await getZonalSchoolIds(req);
        if (schoolIds.length === 0) return res.json({ term: req.query.term || 'Year', schools: [] });
        const term = ['Semester 1', 'Semester 2', 'Year'].includes(req.query.term) ? req.query.term : 'Year';

        const [schools] = await pool.query('SELECT id, school_name FROM schools WHERE id IN (?)', [schoolIds]);
        const reports = await Promise.all(schools.map(async sc => ({
            school_id: sc.id,
            school_name: sc.school_name,
            ...(await getClassLevelAnalysisReport(sc.id, term))
        })));
        res.json({ term, schools: reports });
    } catch (err) {
        console.error("/api/zonal/analysis-reports error:", err);
        res.status(500).json({ error: "Could not load analysis reports" });
    }
});

// ==========================================================
// Well-performing teacher leaderboard (Principal, Academic VP, Admin VP)
// ==========================================================
// Ranks teachers by teaching punctuality (period_attendance_log, trailing
// 30 days) and general attendance (teacher_attendance) — the same two
// signals /api/principal/teacher-audit uses to flag POOR performers, just
// inverted and sorted the other way to surface who's actually showing up
// consistently and teaching their periods. Requires a minimum number of
// logged periods before ranking someone at all, so a teacher with only 1
// or 2 logged periods this month can't land at the top purely on a small
// sample.
app.get('/api/school/teacher-leaderboard', requireAuth, requireAdminTitle('Principal', 'Academic VP', 'Admin VP'), async (req, res) => {
    const MIN_LOGGED_PERIODS = 5;
    try {
        const since = toDateOnly(new Date(Date.now() - 30 * 86400000));
        const [teachers] = await pool.query('SELECT teacher_id, first_name, last_name FROM teachers WHERE school_id = ?', [req.user.school_id]);
        if (teachers.length === 0) return res.json([]);

        const [punctualityRows] = await pool.query(
            `SELECT ct.teacher_id, SUM(pal.teacher_present) AS present_count, COUNT(*) AS total_count
             FROM period_attendance_log pal
             JOIN class_timetable ct ON ct.timetable_id = pal.timetable_id
             WHERE pal.school_id = ? AND pal.log_date >= ?
             GROUP BY ct.teacher_id`,
            [req.user.school_id, since]
        );
        const [absenceRows] = await pool.query(
            `SELECT teacher_id, COUNT(*) AS absent_days FROM teacher_attendance
             WHERE school_id = ? AND status = 'absent' AND attendance_date >= ?
             GROUP BY teacher_id`,
            [req.user.school_id, since]
        );
        const punctualityByTeacher = new Map(punctualityRows.map(r => [r.teacher_id, {
            rate: r.total_count ? Math.round((Number(r.present_count) / Number(r.total_count)) * 100) : null,
            total: Number(r.total_count)
        }]));
        const absenceByTeacher = new Map(absenceRows.map(r => [r.teacher_id, Number(r.absent_days)]));

        const ranked = teachers
            .map(t => {
                const p = punctualityByTeacher.get(t.teacher_id);
                return {
                    teacher_id: t.teacher_id,
                    full_name: [t.first_name, t.last_name].filter(Boolean).join(' '),
                    punctuality_rate: p?.rate ?? null,
                    periods_logged_30d: p?.total ?? 0,
                    absent_days_30d: absenceByTeacher.get(t.teacher_id) || 0
                };
            })
            .filter(t => t.periods_logged_30d >= MIN_LOGGED_PERIODS)
            .sort((a, b) => (b.punctuality_rate - a.punctuality_rate) || (a.absent_days_30d - b.absent_days_30d));

        res.json(ranked);
    } catch (err) {
        console.error("/api/school/teacher-leaderboard error:", err);
        res.status(500).json({ error: "Could not load the teacher leaderboard" });
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