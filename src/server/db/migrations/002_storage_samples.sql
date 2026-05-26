CREATE TABLE IF NOT EXISTS storage_samples (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_name   TEXT NOT NULL,
  taken_at        INTEGER NOT NULL,
  bucket_suffix   TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  object_count    INTEGER NOT NULL,
  partial         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_storage_samples_instance_time
  ON storage_samples(instance_name, taken_at);
