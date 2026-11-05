-- A succeeded parse can carry a warning from the adapter, e.g. that the provider cut its output off.
ALTER TABLE parses ADD COLUMN warning TEXT;
