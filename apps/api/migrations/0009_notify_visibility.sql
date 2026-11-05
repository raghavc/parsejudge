-- Report-ready email preference, and who can open a run's share link.
ALTER TABLE users ADD COLUMN notify_on_done INTEGER NOT NULL DEFAULT 1;
-- 'link': anyone with the share link. 'private': only the owner.
ALTER TABLE runs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'link';
