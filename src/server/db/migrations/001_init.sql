CREATE TABLE IF NOT EXISTS instances (
  name              TEXT PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN ('creating', 'running', 'stopped', 'error')),
  base_domain       TEXT NOT NULL,
  cloud_port        INTEGER NOT NULL,
  site_port         INTEGER NOT NULL,
  admin_key_enc     BLOB NOT NULL,
  instance_secret_enc BLOB NOT NULL,
  postgres_schema   TEXT NOT NULL,
  bucket_prefix     TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_error        TEXT
);

CREATE TABLE IF NOT EXISTS port_allocations (
  port              INTEGER PRIMARY KEY,
  instance_name     TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('cloud', 'site')),
  allocated_at      INTEGER NOT NULL
);
-- No FK to instances(name) on purpose: ports are allocated before the
-- instance row is inserted (to be persisted in it). The orchestrator's
-- delete() flow releases ports explicitly via PortAllocator.release().

CREATE INDEX IF NOT EXISTS idx_port_allocations_instance ON port_allocations(instance_name);

CREATE TABLE IF NOT EXISTS resource_samples (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_name     TEXT NOT NULL,
  taken_at          INTEGER NOT NULL,
  rss_kb            INTEGER NOT NULL,
  cpu_ticks         INTEGER NOT NULL,
  fd_count          INTEGER NOT NULL,
  FOREIGN KEY (instance_name) REFERENCES instances(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_resource_samples_instance_time
  ON resource_samples(instance_name, taken_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                INTEGER NOT NULL,
  actor             TEXT NOT NULL,
  action            TEXT NOT NULL,
  instance_name     TEXT,
  details           TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_log_instance ON audit_log(instance_name);
