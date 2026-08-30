import pg from 'pg';

const { Pool } = pg;

const IDENT_RE = /^[a-z][a-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

// The backend derives its database name from `--instance-name` by replacing
// dashes with underscores (crates/clusters/src/lib.rs, `DbDriverTag::Postgres`
// arm). We must produce the exact same name to create and drop it.
export function databaseNameForInstance(instanceName: string): string {
  const dbName = instanceName.replace(/-/g, '_');
  if (!IDENT_RE.test(dbName)) {
    throw new Error(`instance name does not map to a valid database name: ${instanceName}`);
  }
  return dbName;
}

export interface PostgresConfig {
  // Admin connection string used to create and drop per-instance databases.
  // Should point at the "postgres" maintenance DB.
  adminConnectionString: string;
}

export class DatabaseExistsError extends Error {
  constructor(public readonly dbName: string) {
    super(`database ${dbName} already exists on the cluster`);
  }
}

export class DatabaseMissingError extends Error {
  constructor(public readonly dbName: string) {
    super(`database ${dbName} does not exist on the cluster`);
  }
}

// `postgres-v5` gives every instance its own database on the shared cluster:
// the backend appends the derived db name to the cluster URL itself and
// refuses a URL that already carries a path. This adapter owns the lifecycle
// of those databases. See docs/architecture.md § Design decisions worth
// knowing.
export class PostgresStorage {
  private pool: pg.Pool;

  constructor(cfg: PostgresConfig) {
    this.pool = new Pool({ connectionString: cfg.adminConnectionString, max: 2 });
    // node-pg emits 'error' on the pool when an idle client dies (server
    // restart, network drop). Without a listener node treats it as an
    // unhandled error event and takes the orchestrator down with it.
    this.pool.on('error', (err) => {
      this.onPoolError?.(err);
    });
  }

  // Set by the caller so pool-level failures reach the logger.
  onPoolError?: (err: Error) => void;

  // Fail fast at boot instead of on the first create or start, which may be
  // days later. Also flags a role that cannot create databases, since every
  // new instance needs one.
  async checkAdminAccess(): Promise<{ canCreateDatabases: boolean }> {
    const r = await this.pool.query<{ can: boolean }>(
      'SELECT rolcreatedb OR rolsuper AS can FROM pg_roles WHERE rolname = current_user',
    );
    return { canCreateDatabases: r.rows[0]?.can ?? false };
  }

  async databaseExists(instanceName: string): Promise<boolean> {
    const dbName = databaseNameForInstance(instanceName);
    const r = await this.pool.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [dbName],
    );
    return r.rows[0]?.exists ?? false;
  }

  // Creating an instance must not adopt a database that is already on the
  // cluster: `convex`, `grafana` or `postgres` are all valid instance names,
  // and silently taking one over would put Convex tables into someone else's
  // database and destroy it on delete. Existing means refuse.
  async createDatabaseForInstance(instanceName: string): Promise<string> {
    const dbName = databaseNameForInstance(instanceName);
    try {
      await this.pool.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
    } catch (err: unknown) {
      // 42P04 = duplicate_database, i.e. it appeared between check and create.
      if (isPgError(err, '42P04')) throw new DatabaseExistsError(dbName);
      throw err;
    }
    return dbName;
  }

  // Spawning an existing instance must never create the database: a missing
  // one means the cluster lost it (empty volume, wrong cluster, manual drop),
  // and quietly starting an empty backend would report a healthy instance
  // while the data is gone and backups roll over the good ones.
  async assertDatabaseForInstance(instanceName: string): Promise<void> {
    if (!(await this.databaseExists(instanceName))) {
      throw new DatabaseMissingError(databaseNameForInstance(instanceName));
    }
  }

  // FORCE terminates leftover connections. The supervised backend is already
  // stopped when this runs, but its pool can linger for a moment and would
  // otherwise make the drop fail. It needs pg >= 13, so older clusters get
  // the plain form.
  async dropDatabaseForInstance(instanceName: string): Promise<void> {
    const dbName = databaseNameForInstance(instanceName);
    const force = (await this.serverVersionNum()) >= 130000 ? ' WITH (FORCE)' : '';
    await this.pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)}${force}`);
  }

  private async serverVersionNum(): Promise<number> {
    const r = await this.pool.query<{ v: string }>('SHOW server_version_num');
    return Number(r.rows[0]?.v ?? 0);
  }

  // The URL the Convex backend is spawned with: cluster only, no db name.
  // The backend appends the one derived from --instance-name and errors out
  // on a URL that already has a path.
  clusterUrl(baseClusterUrl: string): string {
    const u = new URL(baseClusterUrl);
    u.pathname = '';
    return u.toString();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}
