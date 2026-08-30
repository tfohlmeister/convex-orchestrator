import { describe, expect, test } from 'bun:test';
import { PostgresStorage, databaseNameForInstance } from './postgres.ts';

describe('databaseNameForInstance', () => {
  test('mirrors the backend mapping of dashes to underscores', () => {
    expect(databaseNameForInstance('lucky-owl-755')).toBe('lucky_owl_755');
    expect(databaseNameForInstance('finance')).toBe('finance');
  });

  test('rejects names that would not be a safe identifier', () => {
    expect(() => databaseNameForInstance('9lives')).toThrow(/valid database name/);
    expect(() => databaseNameForInstance('drop"table')).toThrow(/valid database name/);
    expect(() => databaseNameForInstance('Upper')).toThrow(/valid database name/);
  });
});

describe('clusterUrl', () => {
  // The backend appends the database name itself and refuses a URL that
  // already carries a path, so a stray slash here breaks every spawn.
  const pg = new PostgresStorage({ adminConnectionString: 'postgres://u:p@h:5432/postgres' });

  test('strips a database path', () => {
    expect(pg.clusterUrl('postgres://convex:pw@postgres:5432/convex_tenants')).toBe(
      'postgres://convex:pw@postgres:5432',
    );
  });

  test('leaves a path-less url alone', () => {
    expect(pg.clusterUrl('postgres://convex:pw@postgres:5432')).toBe(
      'postgres://convex:pw@postgres:5432',
    );
  });

  test('keeps a percent-encoded password intact', () => {
    expect(pg.clusterUrl('postgres://convex:p%40ss%2Fword@postgres:5432/')).toBe(
      'postgres://convex:p%40ss%2Fword@postgres:5432',
    );
  });
});
