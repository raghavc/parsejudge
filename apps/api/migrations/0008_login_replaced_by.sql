-- A resend or a new address from the same browser points the earlier sign-in at the one that replaced it,
-- so an upload still running under the earlier one is carried over too.
ALTER TABLE logins ADD COLUMN replaced_by TEXT;
CREATE INDEX logins_replaced_by ON logins (replaced_by);
