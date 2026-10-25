PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS application_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE
  IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('typist', 'resident', 'attending', 'admin')),
    telegram_user_id TEXT UNIQUE,
    can_sign_as_attending INTEGER NOT NULL DEFAULT 0 CHECK (can_sign_as_attending IN (0, 1))
  );


CREATE TABLE IF NOT EXISTS attending_report_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  english_variant TEXT NOT NULL DEFAULT 'british' CHECK (english_variant IN ('british', 'american'))
);

CREATE TABLE IF NOT EXISTS attending_signing_delegates (
  attending_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resident_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (attending_id, resident_id),
  CHECK (attending_id != resident_id)
);
CREATE INDEX IF NOT EXISTS idx_attending_signing_delegates_resident
  ON attending_signing_delegates(resident_id);

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
    study_key TEXT NOT NULL DEFAULT '',
    patient_fullname TEXT NOT NULL DEFAULT '',
    patient_firstname TEXT NOT NULL DEFAULT '',
    patient_lastname TEXT NOT NULL DEFAULT '',
    patient_gender TEXT NOT NULL DEFAULT 'unknown' CHECK (patient_gender IN ('male', 'female', 'unknown')),
    patient_age INTEGER CHECK (patient_age IS NULL OR patient_age >= 0),
    patient_age_unit TEXT NOT NULL DEFAULT 'Y' CHECK (patient_age_unit IN ('Y', 'M', 'W', 'D')),
    source_study_uid TEXT,
    source_component TEXT,
    source_description TEXT,
    source_modality TEXT,
    modality_id INTEGER REFERENCES modalities (id) ON DELETE RESTRICT,
    exam_type_id INTEGER REFERENCES exam_types (id) ON DELETE RESTRICT,
    exam_details TEXT,
    exam_date_jalali TEXT NOT NULL, -- YYYY-MM-DD (Jalali)
    exam_time TEXT NOT NULL, -- HH:MM:SS
    corresponding_resident_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    corresponding_attending_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    dicom_url TEXT,
    description TEXT,
    needs_attention INTEGER NOT NULL DEFAULT 0 CHECK (needs_attention IN (0, 1)),
    attention_note TEXT NOT NULL DEFAULT '' CHECK (length(attention_note) <= 300),
    telegram_message_id TEXT,
    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    telegram_send_started_at INTEGER
  );

CREATE TABLE IF NOT EXISTS study_favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, study_id)
);
CREATE INDEX IF NOT EXISTS idx_study_favorites_study ON study_favorites(study_id);

CREATE TABLE IF NOT EXISTS study_favorite_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 100),
  UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS study_favorite_memberships (
  user_id INTEGER NOT NULL,
  study_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, study_id, category_id),
  FOREIGN KEY (user_id, study_id) REFERENCES study_favorites(user_id, study_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, category_id) REFERENCES study_favorite_categories(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_favorite_memberships_category ON study_favorite_memberships(user_id, category_id, study_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_studies_source_uid ON studies(source_study_uid)
  WHERE source_component IS NULL;

CREATE TABLE IF NOT EXISTS study_recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  modality_id INTEGER REFERENCES modalities(id) ON DELETE RESTRICT,
  exam_type_id INTEGER REFERENCES exam_types(id) ON DELETE RESTRICT,
  exam_details TEXT NOT NULL DEFAULT '',
  audio_report_path TEXT,
  text_report_path TEXT,
  resident_checked INTEGER NOT NULL DEFAULT 0 CHECK (resident_checked IN (0, 1)),
  attending_checked INTEGER NOT NULL DEFAULT 0 CHECK (attending_checked IN (0, 1)),
  typist_checked INTEGER NOT NULL DEFAULT 0,
  typist_signed_by_user_id INTEGER REFERENCES users(id),
  typist_signed_at TEXT,
  processing INTEGER NOT NULL DEFAULT 0 CHECK (processing IN (0, 1)),
  processing_started_at INTEGER,
  telegram_voice_job_id INTEGER UNIQUE,
  corresponding_resident_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_role TEXT CHECK (sender_role IN ('resident', 'attending', 'admin', 'typist')),
  source TEXT NOT NULL DEFAULT 'browser' CHECK (source IN ('browser', 'telegram', 'legacy')),
  resident_signed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  attending_signed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resident_signed_at TEXT,
  attending_signed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recordings_study ON study_recordings(study_id);

CREATE TABLE IF NOT EXISTS recording_examinations (
  recording_id INTEGER NOT NULL REFERENCES study_recordings(id) ON DELETE CASCADE,
  exam_type_id INTEGER NOT NULL REFERENCES exam_types(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  exam_details TEXT NOT NULL DEFAULT '' CHECK (length(exam_details) <= 200),
  PRIMARY KEY (recording_id, position)
);

CREATE TABLE IF NOT EXISTS recording_audio_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id INTEGER NOT NULL REFERENCES study_recordings(id) ON DELETE CASCADE,
  audio_report_path TEXT NOT NULL,
  telegram_voice_job_id INTEGER UNIQUE,
  sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audio_parts_recording ON recording_audio_parts(recording_id);


CREATE TABLE
  IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, -- random token (e.g., 32 bytes hex/base64)
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime ('now')),
    expires_at TEXT NOT NULL
  );


CREATE INDEX IF NOT EXISTS idx_studies_patient_code ON studies (patient_code);
CREATE INDEX IF NOT EXISTS idx_studies_patient_name ON studies (patient_lastname, patient_firstname);

CREATE TABLE IF NOT EXISTS pending_voice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL REFERENCES studies (id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  reply_message_id INTEGER NOT NULL,
  parent_voice_job_id INTEGER REFERENCES pending_voice(id) ON DELETE CASCADE,
  recording_id INTEGER REFERENCES study_recordings(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_role TEXT CHECK (sender_role IN ('resident', 'attending')),
  process_at INTEGER NOT NULL,     -- unix epoch seconds when it’s due
  done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS study_telegram_voices (
  study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  parent_message_id INTEGER,
  sender_name TEXT NOT NULL DEFAULT '',
  message_kind TEXT NOT NULL DEFAULT 'voice' CHECK (message_kind IN ('voice', 'audio')),
  chat_username TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_study_telegram_voices ON study_telegram_voices(study_id);

-- Stop legacy topic index change tracking without deleting existing metadata.
DROP TRIGGER IF EXISTS telegram_index_studies_insert;
DROP TRIGGER IF EXISTS telegram_index_studies_delete;
DROP TRIGGER IF EXISTS telegram_index_studies_update;
DROP TRIGGER IF EXISTS telegram_index_attending_name;
DROP TRIGGER IF EXISTS telegram_index_modality;

CREATE TABLE IF NOT EXISTS telegram_study_refresh (
  study_id INTEGER PRIMARY KEY REFERENCES studies(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'refreshed', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_study_refresh_pending
  ON telegram_study_refresh(retry_at, study_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS pending_telegram (
  study_id INTEGER PRIMARY KEY REFERENCES studies (id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS telegram_group_invitations (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL,
  invite_link TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS telegram_website_links (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL,
  website_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS telegram_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_username TEXT,
  full_name TEXT NOT NULL DEFAULT '',
  role TEXT CHECK (role IN ('resident', 'attending', 'typist')),
  username TEXT COLLATE NOCASE,
  password_hash TEXT,
  step TEXT NOT NULL DEFAULT 'name' CHECK (step IN ('name', 'role', 'username', 'password', 'pending', 'approved', 'rejected')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_username ON telegram_registrations(username)
  WHERE step IN ('password', 'pending');
