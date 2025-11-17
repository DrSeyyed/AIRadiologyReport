PRAGMA foreign_keys = ON;

CREATE TABLE
  IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('typist', 'resident', 'attending', 'admin')),
    email TEXT
  );

CREATE TABLE
  IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_code TEXT UNIQUE NOT NULL,
    firstname TEXT NOT NULL,
    lastname TEXT NOT NULL,
    gender TEXT NOT NULL CHECK (gender IN ('male', 'female')),
    birth_year_jalali INTEGER
  );


CREATE TABLE
  IF NOT EXISTS auth_credentials (
    user_id INTEGER NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  );

CREATE TABLE
  IF NOT EXISTS modalities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  );

CREATE TABLE
  IF NOT EXISTS exam_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  );

CREATE TABLE
  IF NOT EXISTS report_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    modality_id INTEGER NOT NULL REFERENCES modalities (id) ON DELETE RESTRICT,
    exam_type_id INTEGER NOT NULL REFERENCES exam_types (id) ON DELETE RESTRICT,
    text TEXT NOT NULL
  );

CREATE TABLE
  IF NOT EXISTS studies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
    modality_id INTEGER NOT NULL REFERENCES modalities (id) ON DELETE RESTRICT,
    exam_type_id INTEGER NOT NULL REFERENCES exam_types (id) ON DELETE RESTRICT,
    exam_details TEXT,
    exam_date_jalali TEXT NOT NULL, -- YYYY-MM-DD (Jalali)
    exam_time TEXT NOT NULL, -- HH:MM:SS
    corresponding_resident_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    corresponding_attending_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    audio_report_path TEXT,
    text_report_path TEXT,
    resident_checked INTEGER NOT NULL DEFAULT 0 CHECK (resident_checked IN (0, 1)),
    attending_checked INTEGER NOT NULL DEFAULT 0 CHECK (attending_checked IN (0, 1)),
    dicom_url TEXT,
    description TEXT,
    telegram_message_id TEXT
  );


CREATE TABLE
  IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, -- random token (e.g., 32 bytes hex/base64)
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime ('now')),
    expires_at TEXT NOT NULL
  );


CREATE TABLE IF NOT EXISTS pending_voice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  reply_message_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  process_at INTEGER NOT NULL,     -- unix epoch seconds when it’s due
  done INTEGER NOT NULL DEFAULT 0
);


CREATE VIEW IF NOT EXISTS v_study_details AS
SELECT
  s.id                               AS study_id,
  s.patient_id,
  p.patient_code,
  (p.firstname || ' ' || p.lastname) AS patient_full_name,
  p.gender                           AS patient_gender,
  p.birth_year                       AS patient_birth_year,

  s.modality_id,
  m.code                             AS modality_code,
  m.name                             AS modality_name,

  s.exam_type_id,
  et.code                            AS exam_type_code,
  et.name                            AS exam_type_name,

  s.exam_details,
  s.exam_date_jalali,
  s.exam_time,

  s.corresponding_resident_id,
  u_res.full_name                    AS resident_name,

  s.corresponding_attending_id,
  u_att.full_name                    AS attending_name,

  s.audio_report_path,
  s.text_report_path,
  s.resident_checked,
  s.attending_checked,
  s.dicom_url,
  s.description,
  s.telegram_message_id
FROM studies s
JOIN patients   p   ON p.id   = s.patient_id
JOIN modalities m   ON m.id   = s.modality_id
JOIN exam_types et  ON et.id  = s.exam_type_id
LEFT JOIN users u_res ON u_res.id = s.corresponding_resident_id
LEFT JOIN users u_att ON u_att.id = s.corresponding_attending_id;


CREATE VIEW IF NOT EXISTS v_user_sessions AS
SELECT
  s.id            AS session_id,
  s.user_id,
  u.full_name     AS user_full_name,
  u.role          AS user_role,
  u.email         AS user_email,
  s.created_at,
  s.expires_at
FROM sessions s
JOIN users u ON u.id = s.user_id;