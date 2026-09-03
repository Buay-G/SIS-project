// One-off migration: adds optional photo/caption columns to
// school_announcements. Run this once from your SIS-project folder:
//
//   node migrate.js
//
// It reuses the same DB_HOST/DB_USER/DB_PASSWORD/DB_NAME your server.js
// already reads from .env, so there's nothing extra to configure.

import mysql from 'mysql2';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'school_db'
}).promise();

async function columnExists(table, column) {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
    );
    return rows[0].cnt > 0;
}

async function main() {
    try {
        if (!(await columnExists('school_announcements', 'image_url'))) {
            await pool.query('ALTER TABLE school_announcements ADD COLUMN image_url VARCHAR(255) NULL');
            console.log('Added image_url column.');
        } else {
            console.log('image_url column already exists, skipping.');
        }

        if (!(await columnExists('school_announcements', 'image_caption'))) {
            await pool.query('ALTER TABLE school_announcements ADD COLUMN image_caption VARCHAR(255) NULL');
            console.log('Added image_caption column.');
        } else {
            console.log('image_caption column already exists, skipping.');
        }

        console.log('Migration complete.');
    } catch (err) {
        console.error('Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();
