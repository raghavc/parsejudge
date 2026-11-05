-- One-sentence summary of how the providers differ on a page, written after judging.
CREATE TABLE page_notes (
  run_id TEXT NOT NULL REFERENCES runs(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  note TEXT NOT NULL,
  PRIMARY KEY (run_id, page_id)
);
