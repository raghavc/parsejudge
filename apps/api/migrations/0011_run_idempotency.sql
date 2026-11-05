-- start_run retries: one run per (user, key).
ALTER TABLE runs ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX runs_idempotency ON runs (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
