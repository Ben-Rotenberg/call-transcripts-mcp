-- Reference only: the Worker creates this schema itself on first use (ensureSchema in src/index.js).
-- Call recordings and their transcripts
CREATE TABLE IF NOT EXISTS calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,              -- 'drive' | 'upload'
  source_id     TEXT NOT NULL UNIQUE,       -- Drive file id, or upload hash
  file_name     TEXT NOT NULL,
  contact_name  TEXT,
  phone_number  TEXT,
  channel       TEXT,                       -- phone | whatsapp | ...
  direction     TEXT,                       -- Incoming | Outgoing
  call_time     TEXT,                       -- local time from the file name, ISO 'YYYY-MM-DDTHH:MM:SS'
  duration_sec  INTEGER,
  size_bytes    INTEGER,
  sidecar_id    TEXT,                       -- Drive id of the .json metadata file Cube ACR writes
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | partial | error | skipped | expired
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  model         TEXT,
  transcript    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  transcribed_at TEXT,
  exported      INTEGER NOT NULL DEFAULT 0, -- 1 once the Apps Script saved it to Drive as .md
  -- added in v1.2 (the Worker adds them to an existing database by itself):
  segments      TEXT,                       -- JSON [{start,end,text,status}] per transcribed piece of audio
  partial_note  TEXT,                       -- why the transcript is incomplete, if it is
  needs_audio   INTEGER NOT NULL DEFAULT 0, -- 1 = waiting for the Apps Script to send the audio again
  prev_status   TEXT                        -- status to go back to if a re-transcription fails
);
CREATE INDEX IF NOT EXISTS idx_calls_time ON calls(call_time);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);

-- Small key/value table (holds the OpenAI billing alert)
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Full-text index. Trigram tokenizer = substring search, which suits Hebrew
-- (prefixes like ו/ה/ב/ל/ש are glued to words).
CREATE VIRTUAL TABLE IF NOT EXISTS calls_fts USING fts5(
  contact_name, phone_number, transcript,
  content='calls', content_rowid='id', tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS calls_ai AFTER INSERT ON calls BEGIN
  INSERT INTO calls_fts(rowid, contact_name, phone_number, transcript)
  VALUES (new.id, new.contact_name, new.phone_number, new.transcript);
END;
CREATE TRIGGER IF NOT EXISTS calls_ad AFTER DELETE ON calls BEGIN
  INSERT INTO calls_fts(calls_fts, rowid, contact_name, phone_number, transcript)
  VALUES ('delete', old.id, old.contact_name, old.phone_number, old.transcript);
END;
CREATE TRIGGER IF NOT EXISTS calls_au AFTER UPDATE ON calls BEGIN
  INSERT INTO calls_fts(calls_fts, rowid, contact_name, phone_number, transcript)
  VALUES ('delete', old.id, old.contact_name, old.phone_number, old.transcript);
  INSERT INTO calls_fts(rowid, contact_name, phone_number, transcript)
  VALUES (new.id, new.contact_name, new.phone_number, new.transcript);
END;
