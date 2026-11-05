-- Sign-in rate limits count a normalized address (no +tag, no dots for gmail) and an IPv6 /64.
ALTER TABLE logins ADD COLUMN email_key TEXT NOT NULL DEFAULT '';
CREATE INDEX logins_email_key ON logins (email_key, created_at);
CREATE INDEX logins_created ON logins (created_at);
