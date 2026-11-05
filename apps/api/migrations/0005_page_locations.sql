-- Where each judge error is in a parse's output, found by a small model after judging.
-- quotes is a JSON array aligned with the verdict's errors; each item is a list of {text, occurrence}.
CREATE TABLE page_locations (
  run_id TEXT NOT NULL REFERENCES runs(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  preset_id TEXT NOT NULL,
  quotes TEXT NOT NULL,
  PRIMARY KEY (run_id, page_id, preset_id)
);
