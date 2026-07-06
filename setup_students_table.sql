USE school_db;
CREATE TABLE IF NOT EXISTS students (
    student_id VARCHAR(50) PRIMARY KEY,
    school_name VARCHAR(100) DEFAULT 'NEWLAND HIGH SCHOOL',
    first_name VARCHAR(50) NOT NULL,
    middle_name VARCHAR(50),
    last_name VARCHAR(50) NOT NULL,
    sex ENUM('Male', 'Female') NOT NULL,
    class_level INT NOT NULL,
    stream VARCHAR(50) DEFAULT 'General',
    section VARCHAR(5),
    phone_number VARCHAR(20),
    fayda_number VARCHAR(16),
    status ENUM('Active', 'Alumni', 'Pending') DEFAULT 'Active',
    lms_username VARCHAR(50),
    email_address VARCHAR(100),
    assigned_computer VARCHAR(20),
    security_password VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
-- Subjects Table: Stores the list of subjects mapped to their specific streams
CREATE TABLE IF NOT EXISTS subjects (
    subject_id INT AUTO_INCREMENT PRIMARY KEY,
    subject_name VARCHAR(100) NOT NULL,
    stream VARCHAR(50) NOT NULL
) ENGINE=InnoDB;

-- Marks Table: The bridge that links students to their scores
CREATE TABLE IF NOT EXISTS marks (
    mark_id INT AUTO_INCREMENT PRIMARY KEY,
    student_id VARCHAR(50),
    subject_id INT,
    term VARCHAR(20),
    score DECIMAL(5,2),
    date_uploaded TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(subject_id)
) ENGINE=InnoDB;
INSERT INTO subjects (subject_name, stream) VALUES 
-- General (Grade 9-subjects10)
('NUER', 'General'), ('AMHARIC', 'General'), ('ENGLISH', 'General'), ('MATH', 'General'), 
('PHYSICS', 'General'), ('CHEMISTRY', 'General'), ('BIOLOGY', 'General'), ('GEOGRAPHY', 'General'), 
('HISTORY', 'General'), ('ECONOMICS', 'General'), ('CITIZENSHIP', 'General'), ('INFORMATION TECHNOLOGY', 'General'), 
('HEALTH & PHYSICAL EDUCATION', 'General'),

-- Natural Science
('ENGLISH', 'Natural Science'), ('MATH', 'Natural Science'), ('PHYSICS', 'Natural Science'), 
('CHEMISTRY', 'Natural Science'), ('BIOLOGY', 'Natural Science'), ('AGRICULTURE', 'Natural Science'), 
('INFORMATION TECHNOLOGY', 'Natural Science'),

-- Social Science
('ENGLISH', 'Social Science'), ('MATH', 'Social Science'), ('GEOGRAPHY', 'Social Science'), 
('HISTORY', 'Social Science'), ('ECONOMICS', 'Social Science'), ('INFORMATION TECHNOLOGY', 'Social Science');
CREATE TABLE IF NOT EXISTS teacher_assignments (
    assignment_id INT AUTO_INCREMENT PRIMARY KEY,
    teacher_id VARCHAR(50),
    subject_id INT,
    class_level INT,
    section VARCHAR(5),
    stream VARCHAR(50), -- New column added here
    FOREIGN KEY (subject_id) REFERENCES subjects(subject_id)
);
-- Profile and Management
CREATE TABLE IF NOT EXISTS teachers (
    teacher_id VARCHAR(50) PRIMARY KEY,
    full_name VARCHAR(100),
    profile_pic_url VARCHAR(255),
    email VARCHAR(100)
);

-- For Leave/Complaints
CREATE TABLE IF NOT EXISTS support_tickets (
    ticket_id INT AUTO_INCREMENT PRIMARY KEY,
    teacher_id VARCHAR(50),
    message TEXT,
    ticket_type ENUM('Leave Request', 'Complaint'),
    status ENUM('Pending', 'Resolved') DEFAULT 'Pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
SELECT * FROM students;
DESCRIBE marks;
ALTER TABLE marks ADD COLUMN type VARCHAR(20);