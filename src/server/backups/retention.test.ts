import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BackupRepo, type Backup } from '../db/repos.ts';

// Builds a fresh in-memory DB with just the schema we need for BackupRepo
// to exercise its retention queries. We re-create the table by hand instead
// of running the project's migrations to keep the test isolated.
function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE instances (name TEXT PRIMARY KEY);
    CREATE TABLE backups (
      id TEXT PRIMARY KEY,
      instance_name TEXT NOT NULL,
      source TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL,
      target_key TEXT,
      size_bytes INTEGER,
      sha256 TEXT,
      convex_version TEXT,
      error_message TEXT
    );
  `);
  db.prepare('INSERT INTO instances (name) VALUES (?)').run('inst-a');
  return db;
}

function fakeBackup(over: Partial<Backup>): Backup {
  return {
    id: over.id ?? crypto.randomUUID(),
    instanceName: over.instanceName ?? 'inst-a',
    source: over.source ?? 'auto',
    startedAt: over.startedAt ?? Date.now(),
    completedAt: over.completedAt ?? null,
    status: over.status ?? 'complete',
    targetKey: over.targetKey ?? `target/${crypto.randomUUID()}.zip`,
    sizeBytes: over.sizeBytes ?? 1234,
    sha256: over.sha256 ?? 'abc',
    convexVersion: over.convexVersion ?? 'v1',
    errorMessage: over.errorMessage ?? null,
  };
}

let db: Database;
let repo: BackupRepo;

beforeEach(() => {
  db = freshDb();
  repo = new BackupRepo(db);
});

afterEach(() => {
  db.close();
});

describe('BackupRepo retention filter', () => {
  test('listOlderThan returns only matching source AND completed backups older than cutoff', () => {
    const now = Date.now();
    const old = fakeBackup({
      startedAt: now - 40 * 86_400_000,
      source: 'auto',
      status: 'complete',
    });
    const recent = fakeBackup({
      startedAt: now - 10 * 86_400_000,
      source: 'auto',
      status: 'complete',
    });
    const manualOld = fakeBackup({
      startedAt: now - 40 * 86_400_000,
      source: 'manual',
      status: 'complete',
    });
    const preRestoreOld = fakeBackup({
      startedAt: now - 40 * 86_400_000,
      source: 'pre-restore',
      status: 'complete',
    });
    const failedOld = fakeBackup({
      startedAt: now - 40 * 86_400_000,
      source: 'auto',
      status: 'failed',
    });
    repo.insert(old);
    repo.insert(recent);
    repo.insert(manualOld);
    repo.insert(preRestoreOld);
    repo.insert(failedOld);

    const cutoff = now - 30 * 86_400_000;
    const result = repo.listOlderThan('inst-a', 'auto', cutoff);
    expect(result.map((b) => b.id)).toEqual([old.id]);
  });
});

describe('BackupRepo.consecutiveAutoFailures', () => {
  test('counts trailing failures across auto rows', () => {
    repo.insert(fakeBackup({ source: 'auto', status: 'complete', startedAt: 1 }));
    repo.insert(fakeBackup({ source: 'auto', status: 'failed', startedAt: 2 }));
    repo.insert(fakeBackup({ source: 'auto', status: 'failed', startedAt: 3 }));
    repo.insert(fakeBackup({ source: 'auto', status: 'failed', startedAt: 4 }));
    expect(repo.consecutiveAutoFailures('inst-a')).toBe(3);
  });

  test('stops counting at the first success', () => {
    repo.insert(fakeBackup({ source: 'auto', status: 'failed', startedAt: 1 }));
    repo.insert(fakeBackup({ source: 'auto', status: 'complete', startedAt: 2 }));
    repo.insert(fakeBackup({ source: 'auto', status: 'failed', startedAt: 3 }));
    expect(repo.consecutiveAutoFailures('inst-a')).toBe(1);
  });

  test('ignores manual / pre-restore rows', () => {
    repo.insert(fakeBackup({ source: 'manual', status: 'failed', startedAt: 1 }));
    repo.insert(fakeBackup({ source: 'pre-restore', status: 'failed', startedAt: 2 }));
    repo.insert(fakeBackup({ source: 'auto', status: 'complete', startedAt: 3 }));
    expect(repo.consecutiveAutoFailures('inst-a')).toBe(0);
  });
});
