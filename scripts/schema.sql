PRAGMA foreign_keys = ON;

CREATE TABLE
  IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('typist', 'resident', 'attending', 'admin')),
    email TEXT
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
    patient_code TEXT NOT NULL,
    patient_firstname TEXT NOT NULL DEFAULT '',
    patient_lastname TEXT NOT NULL DEFAULT '',
    patient_gender TEXT NOT NULL DEFAULT 'unknown' CHECK (patient_gender IN ('male', 'female', 'unknown')),
    patient_age INTEGER CHECK (patient_age IS NULL OR patient_age >= 0),
    patient_age_unit TEXT NOT NULL DEFAULT 'Y' CHECK (patient_age_unit IN ('Y', 'M', 'W', 'D')),
    source_study_uid TEXT,
    source_component TEXT,
    source_description TEXT,
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
    telegram_message_id TEXT,
    UNIQUE (source_study_uid, source_component)
  );


CREATE TABLE
  IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, -- random token (e.g., 32 bytes hex/base64)
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime ('now')),
    expires_at TEXT NOT NULL
  );


CREATE INDEX IF NOT EXISTS idx_studies_patient_code ON studies (patient_code);
CREATE INDEX IF NOT EXISTS idx_studies_patient_name ON studies (patient_lastname, patient_firstname);

CREATE TABLE IF NOT EXISTS study_import_mappings (
  id INTEGER PRIMARY KEY,
  modality_id INTEGER NOT NULL REFERENCES modalities (id),
  source_description TEXT NOT NULL,
  description_key TEXT NOT NULL,
  UNIQUE (modality_id, description_key)
);

CREATE TABLE IF NOT EXISTS study_import_components (
  id INTEGER PRIMARY KEY,
  mapping_id INTEGER NOT NULL REFERENCES study_import_mappings (id) ON DELETE CASCADE,
  exam_type_id INTEGER NOT NULL REFERENCES exam_types (id),
  exam_details TEXT NOT NULL DEFAULT '',
  UNIQUE (mapping_id, exam_type_id, exam_details)
);

CREATE TABLE IF NOT EXISTS pending_voice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL REFERENCES studies (id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  reply_message_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  process_at INTEGER NOT NULL,     -- unix epoch seconds when it’s due
  done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pending_telegram (
  study_id INTEGER PRIMARY KEY REFERENCES studies (id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0
);
