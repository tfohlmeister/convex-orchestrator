-- Persist restore-job state so polling survives an orchestrator restart.
-- Previously the RestoreManager held jobs in an in-process Map and any
-- restart turned every poll into a generic 404, indistinguishable from
-- "you typo'd the id". Persisting them lets the API return a distinct
-- response and lets the UI show the truth: the import may have
-- completed but the orchestrator crashed mid-flight; check the audit
-- log + the pre-restore backup for the rollback point.
CREATE TABLE IF NOT EXISTS restore_jobs (
  id                     TEXT PRIMARY KEY,
  instance_name          TEXT NOT NULL,
  source_backup_id       TEXT NOT NULL,
  pre_restore_backup_id  TEXT,
  status                 TEXT NOT NULL CHECK (status IN (
    'queued', 'pre-backup', 'stopping', 'starting', 'importing', 'complete', 'failed'
  )),
  error                  TEXT,
  started_at             INTEGER NOT NULL,
  completed_at           INTEGER,
  FOREIGN KEY (instance_name) REFERENCES instances(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_restore_jobs_instance_started
  ON restore_jobs(instance_name, started_at DESC);
