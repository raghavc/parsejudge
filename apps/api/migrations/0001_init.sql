CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('pdf', 'docx', 'pptx')),
  sha256 TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  page_index INTEGER NOT NULL,
  rendered INTEGER NOT NULL DEFAULT 0,
  UNIQUE (document_id, page_index)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  share_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  preset_ids TEXT NOT NULL,
  judge_version TEXT NOT NULL,
  judge_model TEXT NOT NULL,
  summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE run_documents (
  run_id TEXT NOT NULL REFERENCES runs(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  PRIMARY KEY (run_id, document_id)
);

CREATE TABLE parses (
  run_id TEXT NOT NULL REFERENCES runs(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  preset_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  latency_ms INTEGER,
  cost_usd REAL,
  cost_source TEXT,
  error TEXT,
  PRIMARY KEY (run_id, page_id, preset_id)
);

CREATE TABLE verdicts (
  run_id TEXT NOT NULL REFERENCES runs(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  preset_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  reasoning TEXT NOT NULL,
  errors TEXT NOT NULL,
  PRIMARY KEY (run_id, page_id, preset_id)
);

-- BYOK keys, AES-GCM encrypted with CREDENTIALS_KEY. Deleted when the run ends.
CREATE TABLE run_credentials (
  run_id TEXT NOT NULL REFERENCES runs(id),
  provider TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (run_id, provider)
);

CREATE INDEX runs_user ON runs (user_id, created_at DESC);
CREATE INDEX documents_user ON documents (user_id, created_at DESC);

CREATE TABLE judge_failures (
  run_id TEXT NOT NULL REFERENCES runs(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  error TEXT NOT NULL,
  PRIMARY KEY (run_id, page_id)
);
