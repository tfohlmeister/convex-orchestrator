import { Database } from 'bun:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export type DB = Database;

export async function openDatabase(path: string): Promise<DB> {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  await applyMigrations(db);
  return db;
}

async function applyMigrations(db: DB): Promise<void> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    db
      .query<{ id: string }, []>('SELECT id FROM schema_migrations')
      .all()
      .map((r) => r.id),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const insertApplied = db.prepare<unknown, [string, number]>(
    'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      insertApplied.run(file, Date.now());
    })();
  }
}
