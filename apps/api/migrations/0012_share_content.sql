-- Owners can share a report's scores without its pages: 0 hides documents, page images and parser output from link viewers.
ALTER TABLE runs ADD COLUMN share_content INTEGER NOT NULL DEFAULT 1;
