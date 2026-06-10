import express from 'express';
import mysql from 'mysql2';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors()); // This allows the React app to send data to this server

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'B2000_mun@14', // Ensure this matches your MySQL setup
  database: 'school_db'
});

// The endpoint to receive student data
app.post('/add-student', (req, res) => {
  const { full_name, date_of_birth, grade_level, parent_contact } = req.body;
  const sql = "INSERT INTO students (full_name, date_of_birth, grade_level, parent_contact) VALUES (?, ?, ?, ?)";
  
  pool.query(sql, [full_name, date_of_birth, grade_level, parent_contact], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    return res.json({ message: "Student added successfully!", id: result.insertId });
  });
});

app.listen(3001, () => console.log("Server running on port 3001"));