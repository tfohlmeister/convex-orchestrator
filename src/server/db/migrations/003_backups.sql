CREATE TABLE IF NOT EXISTS backups (
  id              TEXT PRIMARY KEY,
  instance_name   TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'manual-upload', 'pre-restore')),
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'stuck', 'corrupt')),
  target_key      TEXT,
  size_bytes      INTEGER,
  sha256          TEXT,
  convex_version  TEXT,
  error_message   TEXT,
  FOREIGN KEY (instance_name) REFERENCES instances(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_backups_instance_started ON backups(instance_name, started_at);
CREATE INDEX IF NOT EXISTS idx_backups_status ON backups(status);

-- Per-instance backup config. NULL = fall back to orchestrator defaults.
ALTER TABLE instances ADD COLUMN backup_cron TEXT;
ALTER TABLE instances ADD COLUMN backup_retention_days INTEGER;
ALTER TABLE instances ADD COLUMN backup_enabled INTEGER;
-- Suspended after BACKUP_MAX_CONSECUTIVE_FAILURES; cleared on manual re-enable.
ALTER TABLE instances ADD COLUMN backup_suspended INTEGER NOT NULL DEFAULT 0;
