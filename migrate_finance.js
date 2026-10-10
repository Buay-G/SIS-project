// One-off migration (Finance feature, Phase 3): Finance accounts, fee
// setup, and registration payments.
//
// Run this ONCE from your SIS-project folder, BEFORE restarting server.js
// with the Phase 3 changes:
//
//   node migrate_finance.js
//
// Safe to run twice — every step checks first and skips what already exists.

import mysql from 'mysql2';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'school_db'
}).promise();

async function tableExists(table) {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ?`,
        [table]
    );
    return rows[0].cnt > 0;
}

async function createTableIfMissing(table, ddl) {
    if (await tableExists(table)) {
        console.log(`${table} already exists, skipping.`);
        return;
    }
    await pool.query(ddl);
    console.log(`Created ${table}.`);
}

async function main() {
    try {
        // One Finance account per school. Same shape/spirit as
        // school_admins: bcrypt password, forced change on first login,
        // is_active for when they're replaced.
        await createTableIfMissing(
            'finance_users',
            `CREATE TABLE finance_users (
                finance_id VARCHAR(20) PRIMARY KEY,
                school_id INT NOT NULL,
                first_name VARCHAR(100) NOT NULL,
                middle_name VARCHAR(100) NULL,
                last_name VARCHAR(100) NOT NULL,
                sex VARCHAR(10) NULL,
                contact_number VARCHAR(20) NULL,
                email VARCHAR(150) NULL,
                security_password VARCHAR(255) NOT NULL,
                must_change_password TINYINT(1) NOT NULL DEFAULT 1,
                is_active TINYINT(1) NOT NULL DEFAULT 1,
                created_by VARCHAR(50) NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                KEY idx_finance_school (school_id)
            )`
        );

        // One row per school per academic year. registration_fee applies to
        // every school; monthly_fee is only ever read/charged when the
        // school's governance model is private (see governance.js).
        await createTableIfMissing(
            'fee_structures',
            `CREATE TABLE fee_structures (
                id INT AUTO_INCREMENT PRIMARY KEY,
                school_id INT NOT NULL,
                academic_year VARCHAR(20) NOT NULL,
                registration_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
                monthly_fee DECIMAL(10,2) NULL,
                set_by VARCHAR(20) NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_school_year (school_id, academic_year)
            )`
        );

        // One row per registration payment. A student can have more than
        // one row over time (e.g. rejected then re-submitted), so this is
        // NOT unique on student_id — the student's CURRENT status is what
        // gates login/placement, this table is the paper trail behind it.
        await createTableIfMissing(
            'fee_payments',
            `CREATE TABLE fee_payments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                school_id INT NOT NULL,
                student_id VARCHAR(50) NOT NULL,
                fee_type ENUM('REGISTRATION','MONTHLY') NOT NULL DEFAULT 'REGISTRATION',
                amount DECIMAL(10,2) NOT NULL,
                method ENUM('CASH','BANK','MOBILE') NOT NULL,
                reference_number VARCHAR(100) NULL,
                receipt_photo_url VARCHAR(255) NULL,
                status ENUM('PENDING','VERIFIED','REJECTED') NOT NULL DEFAULT 'PENDING',
                submitted_by VARCHAR(50) NOT NULL,
                submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                receipt_no INT NULL,
                verified_by VARCHAR(20) NULL,
                verified_at DATETIME NULL,
                rejection_reason VARCHAR(255) NULL,
                KEY idx_fee_payments_school (school_id),
                KEY idx_fee_payments_student (student_id),
                -- A bank/mobile reference can only ever fund ONE payment at
                -- this school — the exact reuse-the-receipt gap flagged
                -- earlier. Cash rows have no reference_number so they sit
                -- outside this rule (MySQL treats NULL as distinct every time).
                UNIQUE KEY uniq_school_reference (school_id, reference_number)
            )`
        );

        // Race-safe sequential Finance IDs (FIN0001, FIN0002, ...) — same
        // LAST_INSERT_ID() trick as the existing staff_id_seq table for
        // teacher/school-admin IDs, kept separate so Finance accounts don't
        // share a counter (and prefix) with teachers/admins.
        await createTableIfMissing(
            'finance_id_seq',
            `CREATE TABLE finance_id_seq (
                id TINYINT NOT NULL PRIMARY KEY,
                next_val INT NOT NULL
            )`
        );
        const [seqRows] = await pool.query('SELECT id FROM finance_id_seq WHERE id = 1');
        if (seqRows.length === 0) {
            await pool.query('INSERT INTO finance_id_seq (id, next_val) VALUES (1, 1)');
            console.log('Seeded finance_id_seq.');
        } else {
            console.log('finance_id_seq already seeded, skipping.');
        }

        console.log('\nNext steps:');
        console.log(
            '  1. Principal (public school) or Managing Director (private school) creates the Finance account.'
        );
        console.log('  2. Finance sets the registration fee (and monthly fee, for private schools).');
        console.log('Migration complete.');
    } catch (err) {
        console.error('Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();
