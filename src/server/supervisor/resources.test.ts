import { describe, expect, test } from 'bun:test';
import { parseProcStats } from './resources.ts';

// Synthetic /proc fixtures. The pid/uid/start-time numbers are made up;
// only the structure matters. proc(5) is the authoritative reference.
const minimalStatus = (rssKb: number): string =>
  `Name:\tconvex\nState:\tS (sleeping)\nVmRSS:\t   ${rssKb} kB\n`;

// pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime ...
function buildStat(comm: string, utime: number, stime: number): string {
  // 12 fields between state (index 0 in the post-paren slice) and utime
  // (index 11). state + ppid + pgrp + session + tty_nr + tpgid + flags
  // + minflt + cminflt + majflt + cmajflt = 11 fields → utime is index 11.
  const filler = ['S', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
  const fields = [...filler, String(utime), String(stime), '0', '0'];
  return `42 (${comm}) ${fields.join(' ')}\n`;
}

describe('parseProcStats', () => {
  test('extracts rssKb from VmRSS line', () => {
    const out = parseProcStats(minimalStatus(12345), buildStat('convex', 0, 0), 0);
    expect(out.rssKb).toBe(12345);
  });

  test('rssKb falls back to 0 when VmRSS is missing (kernel thread, etc.)', () => {
    const out = parseProcStats(
      'Name:\tconvex\nState:\tS (sleeping)\n',
      buildStat('convex', 0, 0),
      0,
    );
    expect(out.rssKb).toBe(0);
  });

  test('cpuTicks sums utime + stime', () => {
    const out = parseProcStats(minimalStatus(100), buildStat('convex', 70, 30), 0);
    expect(out.cpuTicks).toBe(100);
  });

  test('fdCount is passed through verbatim', () => {
    const out = parseProcStats(minimalStatus(100), buildStat('convex', 0, 0), 42);
    expect(out.fdCount).toBe(42);
  });

  test('handles comm names containing ")" — lastIndexOf parse trick', () => {
    // Real Linux example: a process named "(bad) name)" would break a
    // naive split-by-space; the lastIndexOf(')') trick locates the
    // closing paren of the comm field even when comm itself contains
    // ')'.
    const stat = buildStat('weird (sub) name)', 50, 25);
    const out = parseProcStats(minimalStatus(100), stat, 0);
    expect(out.cpuTicks).toBe(75);
  });

  test('handles comm names containing whitespace', () => {
    const stat = buildStat('convex backend with spaces', 12, 34);
    const out = parseProcStats(minimalStatus(100), stat, 0);
    expect(out.cpuTicks).toBe(46);
  });

  test('returns zeros instead of NaN when stat is malformed (truncated)', () => {
    // Truncated stat line — fields after the closing paren are missing.
    const out = parseProcStats(minimalStatus(100), '42 (convex)\n', 0);
    expect(Number.isNaN(out.cpuTicks)).toBe(false);
    expect(out.cpuTicks).toBe(0);
  });

  test('large utime + stime do not overflow (Linux kernel uses unsigned long long)', () => {
    const big = 2_000_000_000;
    const out = parseProcStats(minimalStatus(100), buildStat('convex', big, big), 0);
    expect(out.cpuTicks).toBe(4_000_000_000);
  });
});
