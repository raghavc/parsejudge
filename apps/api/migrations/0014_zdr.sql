-- Runs and uploads started from /zdr: their documents are deleted 24 hours later; the run's results stay.
ALTER TABLE runs ADD COLUMN zdr INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN zdr INTEGER NOT NULL DEFAULT 0;
