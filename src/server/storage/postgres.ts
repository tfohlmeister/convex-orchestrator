import pg from 'pg';

const { Pool } = pg;

const IDENT_RE = /^[a-z][a-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

export interface PostgresConfig {
  // Admin connection string used only to ensure the shared multitenant
  // database exists. Should point at the "postgres" maintenance DB.
  adminConnectionString: string;
  // The shared database all Convex tenants write into (passed to the backend
  // as the positional DB_SPEC with the db name appended).
  sharedDatabase: string;
}

// `postgres-v5-multitenant` mode means ONE shared database for all tenants,
// no per-instance schemas — this adapter's job is trivial: make sure the
// shared database exists. Tenant isolation is enforced inside the Convex
// backend by the `instance_name` column on every system table. See
// docs/architecture.md § Design decisions worth knowing for the empirical
// findings that drove this choice.
export class PostgresStorage {
  private pool: pg.Pool;

  constructor(private readonly cfg: PostgresConfig) {
    if (!IDENT_RE.test(cfg.sharedDatabase)) {
      throw new Error(`invalid sharedDatabase identifier: ${cfg.sharedDatabase}`);
    }
    this.pool = new Pool({ connectionString: cfg.adminConnectionString, max: 2 });
  }

  async ensureSharedDatabaseExists(): Promise<void> {
    const r = await this.pool.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [this.cfg.sharedDatabase],
    );
    if (!r.rows[0]?.exists) {
      await this.pool.query(`CREATE DATABASE ${quoteIdent(this.cfg.sharedDatabase)}`);
    }
  }

  // Returns the URL the Convex backend should be spawned with. The DB name
  // MUST be part of the URL in multitenant mode (verified empirically).
  databaseUrlForInstance(baseClusterUrl: string): string {
    const u = new URL(baseClusterUrl);
    u.pathname = `/${this.cfg.sharedDatabase}`;
    return u.toString();
  }

  sharedDatabaseName(): string {
    return this.cfg.sharedDatabase;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
