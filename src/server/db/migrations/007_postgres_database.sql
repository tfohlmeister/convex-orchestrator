-- postgres-v5 gives every instance its own database instead of a row-level
-- tenant in one shared database, so the column now holds a real database
-- name. Existing rows carried the shared database name; derive the new one
-- the same way the backend does (dashes to underscores).
ALTER TABLE instances RENAME COLUMN postgres_schema TO postgres_database;
UPDATE instances SET postgres_database = replace(name, '-', '_');
