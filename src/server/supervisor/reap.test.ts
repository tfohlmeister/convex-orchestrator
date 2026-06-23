import { describe, expect, test } from 'bun:test';
import { parsePpidFromStat, listDescendants, killAll, type ProcReader } from './reap.ts';

describe('parsePpidFromStat', () => {
  test('reads ppid as the field after state', () => {
    // pid (comm) state ppid pgrp ...
    expect(parsePpidFromStat('1234 (convex-local) S 1000 1234 1000')).toBe(1000);
  });

  test('handles a comm containing spaces and parens', () => {
    expect(parsePpidFromStat('77 (weird (name) ) S 42 77')).toBe(42);
  });

  test('returns null for unparseable input', () => {
    expect(parsePpidFromStat('garbage-without-parens')).toBe(null);
  });
});

// In-memory /proc: a process tree
//   100 -> 200 -> 300
//        -> 201
//   500 (unrelated)
const TREE: Record<number, number> = {
  100: 1,
  200: 100,
  300: 200,
  201: 100,
  500: 1,
};

function fakeReader(tree: Record<number, number>): ProcReader {
  return {
    listPids: () => Promise.resolve(Object.keys(tree).map(Number)),
    parentOf: (pid) => Promise.resolve(tree[pid] ?? null),
  };
}

describe('listDescendants', () => {
  test('returns all transitive descendants, excluding the root', async () => {
    const got = await listDescendants(100, fakeReader(TREE));
    expect(got.sort((a, b) => a - b)).toEqual([200, 201, 300]);
  });

  test('returns an empty list for a leaf', async () => {
    expect(await listDescendants(300, fakeReader(TREE))).toEqual([]);
  });

  test('returns an empty list for an unknown pid', async () => {
    expect(await listDescendants(99999, fakeReader(TREE))).toEqual([]);
  });

  test('does not loop forever on a cyclic parent map', async () => {
    const cyclic = { 1: 2, 2: 1 };
    const got = await listDescendants(1, fakeReader(cyclic));
    expect(got).toEqual([2]);
  });
});

describe('killAll', () => {
  test('signals every pid and reports the ones it reached', () => {
    const sent: { pid: number; signal: string }[] = [];
    const killed = killAll([10, 20, 30], (pid, signal) => sent.push({ pid, signal }));
    expect(killed).toEqual([10, 20, 30]);
    expect(sent).toEqual([
      { pid: 10, signal: 'SIGKILL' },
      { pid: 20, signal: 'SIGKILL' },
      { pid: 30, signal: 'SIGKILL' },
    ]);
  });

  test('swallows per-pid errors (already-gone process) and continues', () => {
    const killed = killAll([1, 2, 3], (pid) => {
      if (pid === 2) throw new Error('ESRCH');
    });
    expect(killed).toEqual([1, 3]);
  });
});
