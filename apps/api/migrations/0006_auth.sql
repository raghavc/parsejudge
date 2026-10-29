-- Email sign-in. A login is one emailed code + link; a session is one signed-in browser.
-- Secrets are stored only as HMACs (AUTH_KEY).
CREATE TABLE logins (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  link_hash TEXT NOT NULL,
  preset_ids TEXT NOT NULL,
  ip TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  user_id TEXT
);
CREATE INDEX logins_email ON logins (email, created_at);
CREATE INDEX logins_ip ON logins (ip, created_at);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Uploads made while sign-in is open belong to the 'pending' user and move to the real user when it completes.
ALTER TABLE documents ADD COLUMN login_id TEXT;
CREATE INDEX documents_login ON documents (login_id);
INSERT INTO users (id, email, created_at) VALUES ('pending', 'pending@parsejudge.invalid', 0);
