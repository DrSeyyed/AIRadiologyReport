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
    birth_year INTEGER
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
    patient_age INTEGER CHECK (patient_age IS NULL OR patient_age >= 0)
  );


CREATE TABLE
  IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, -- random token (e.g., 32 bytes hex/base64)
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime ('now')),
    expires_at TEXT NOT NULL
  );


  -- After INSERT on studies: compute patient_age
CREATE TRIGGER IF NOT EXISTS trg_studies_ai_set_age
AFTER INSERT ON studies
FOR EACH ROW
BEGIN
  UPDATE studies
     SET patient_age = (
       CASE
         WHEN (SELECT birth_year FROM patients WHERE id = NEW.patient_id) IS NOT NULL
              AND substr(NEW.exam_date_jalali,1,4) GLOB '[0-9][0-9][0-9][0-9]'
         THEN CAST(substr(NEW.exam_date_jalali,1,4) AS INTEGER)
              - (SELECT birth_year FROM patients WHERE id = NEW.patient_id)
         ELSE NULL
       END
     )
   WHERE id = NEW.id;
END;

-- After UPDATE on studies (when exam date or patient changes): recompute
CREATE TRIGGER IF NOT EXISTS trg_studies_au_set_age
AFTER UPDATE OF exam_date_jalali, patient_id ON studies
FOR EACH ROW
BEGIN
  UPDATE studies
     SET patient_age = (
       CASE
         WHEN (SELECT birth_year FROM patients WHERE id = NEW.patient_id) IS NOT NULL
              AND substr(NEW.exam_date_jalali,1,4) GLOB '[0-9][0-9][0-9][0-9]'
         THEN CAST(substr(NEW.exam_date_jalali,1,4) AS INTEGER)
              - (SELECT birth_year FROM patients WHERE id = NEW.patient_id)
         ELSE NULL
       END
     )
   WHERE id = NEW.id;
END;

-- If a patient's birth_year changes: propagate to all their studies
CREATE TRIGGER IF NOT EXISTS trg_patients_au_propagate_age
AFTER UPDATE OF birth_year ON patients
FOR EACH ROW
BEGIN
  UPDATE studies
     SET patient_age = (
       CASE
         WHEN NEW.birth_year IS NOT NULL
              AND substr(exam_date_jalali,1,4) GLOB '[0-9][0-9][0-9][0-9]'
         THEN CAST(substr(exam_date_jalali,1,4) AS INTEGER) - NEW.birth_year
         ELSE NULL
       END
     )
   WHERE patient_id = NEW.id;
END;