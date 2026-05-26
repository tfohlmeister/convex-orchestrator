import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PortRepo } from './db/repos.ts';
import { PortAllocator, PORT_RANGE_START } from './ports.ts';

describe('PortAllocator', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE instances (name TEXT PRIMARY KEY);
      CREATE TABLE port_allocations (
        port INTEGER PRIMARY KEY,
        instance_name TEXT NOT NULL,
        role TEXT NOT NULL,
        allocated_at INTEGER NOT NULL,
        FOREIGN KEY (instance_name) REFERENCES instances(name) ON DELETE CASCADE
      );
    `);
    db.prepare('INSERT INTO instances (name) VALUES (?)').run('foo');
    db.prepare('INSERT INTO instances (name) VALUES (?)').run('bar');
  });

  afterEach(() => {
    db.close();
  });

  test('allocates two consecutive free ports for a fresh instance', () => {
    const alloc = new PortAllocator(new PortRepo(db));
    const ports = alloc.allocatePair('foo');
    expect(ports.cloud).toBe(PORT_RANGE_START);
    expect(ports.site).toBe(PORT_RANGE_START + 1);
  });

  test('skips already-reserved ports', () => {
    const repo = new PortRepo(db);
    repo.reserve(PORT_RANGE_START, 'foo', 'cloud');
    const alloc = new PortAllocator(repo);
    const ports = alloc.allocatePair('bar');
    expect(ports.cloud).toBe(PORT_RANGE_START + 1);
    expect(ports.site).toBe(PORT_RANGE_START + 2);
  });

  test('release frees ports for the instance', () => {
    const repo = new PortRepo(db);
    const alloc = new PortAllocator(repo);
    alloc.allocatePair('foo');
    alloc.release('foo');
    expect(repo.allReserved().size).toBe(0);
  });
});
