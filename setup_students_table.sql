USE school_db;

DROP TABLE IF EXISTS students;

CREATE TABLE students (
    student_id VARCHAR(50) PRIMARY KEY, -- Student provides this ID
    school_name VARCHAR(100),
    first_name VARCHAR(50),
    middle_name VARCHAR(50),
    last_name VARCHAR(50),
    sex VARCHAR(10),
    class_level VARCHAR(10),
    stream VARCHAR(50),
    section VARCHAR(10),
    phone_number VARCHAR(20),
    fayda_number VARCHAR(16),
    fayda_status VARCHAR(50),
    lms_username VARCHAR(50),
    email_address VARCHAR(100),
    assigned_computer VARCHAR(20),
    security_password VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE students 
MODIFY phone_number VARCHAR(20) DEFAULT 'Not Provided',
MODIFY fayda_status VARCHAR(50) DEFAULT 'Pending',
MODIFY stream VARCHAR(50) DEFAULT 'General';
SELECT * FROM students ORDER BY created_at DESC;