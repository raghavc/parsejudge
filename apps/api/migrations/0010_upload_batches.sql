-- Files PUT through one MCP upload URL share its upload id, so an agent can start a run from the id alone.
ALTER TABLE documents ADD COLUMN upload_id TEXT;
CREATE INDEX documents_upload ON documents (user_id, upload_id);
