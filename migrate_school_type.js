// One-off migration (Finance feature, Phase 1): adds schools.school_type.
//
//   PUBLIC  = Government / Public school -> registration fee only
//   PRIVATE = Private school             -> registration fee + monthly school fee
//
// Run this ONCE from your SIS-project folder, BEFORE restarting server.js
// with the Phase 1 changes (the Schools screen reads this column):
//
//   node migrate_school_type.js
//
// It reuses the same DB_HOST/DB_USER/DB_PASSWORD/DB_NAME your server.js
// already reads from .env, so there's nothing extra to configure.
// Safe to run twice: it skips the change if the column already exists.
//
// Every school that already exists is set to PUBLIC by the column default.
// After running this, open Super Admin -> Schools -> Edit on each PRIVATE
// school and change its School Type.

import mysql from "mysql2";
import dotenv from "dotenv";
dotenv.config();

const pool = mysql
  .createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "school_db",
  })
  .promise();

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  return rows[0].cnt > 0;
}

async function main() {
  try {
    if (!(await columnExists("schools", "school_type"))) {
      await pool.query(
        `ALTER TABLE schools
                 ADD COLUMN school_type ENUM('PUBLIC','PRIVATE') NOT NULL DEFAULT 'PUBLIC'
                 AFTER school_level`,
      );
      console.log(
        "Added schools.school_type (existing schools set to PUBLIC).",
      );
    } else {
      console.log("schools.school_type already exists, skipping.");
    }

    const [schools] = await pool.query(
      "SELECT id, school_name, school_type FROM schools WHERE is_archived = 0 ORDER BY id",
    );
    console.log("\nCurrent schools:");
    schools.forEach((s) =>
      console.log(`  #${s.id}  ${s.school_type.padEnd(7)}  ${s.school_name}`),
    );
    console.log(
      "\nNext step: in Super Admin -> Schools -> Edit, set the School Type of every PRIVATE school.",
    );
    console.log("Migration complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
