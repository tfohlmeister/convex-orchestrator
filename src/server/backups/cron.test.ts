import { describe, expect, test } from 'bun:test';
import { parseCron, nextCronFire } from './cron.ts';

describe('parseCron', () => {
  test('parses 5 fields with wildcards', () => {
    const e = parseCron('* * * * *');
    expect(e.minutes.size).toBe(60);
    expect(e.hours.size).toBe(24);
    expect(e.daysOfMonth.size).toBe(31);
    expect(e.months.size).toBe(12);
    expect(e.daysOfWeek.size).toBe(7);
  });

  test('parses single value', () => {
    const e = parseCron('0 3 * * *');
    expect([...e.minutes]).toEqual([0]);
    expect([...e.hours]).toEqual([3]);
  });

  test('parses comma list', () => {
    const e = parseCron('0,15,30,45 * * * *');
    expect([...e.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  test('parses range', () => {
    const e = parseCron('0 9-17 * * *');
    expect([...e.hours].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  test('parses step value', () => {
    const e = parseCron('*/15 * * * *');
    expect([...e.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  test('parses range/step', () => {
    const e = parseCron('0 8-18/2 * * *');
    expect([...e.hours].sort((a, b) => a - b)).toEqual([8, 10, 12, 14, 16, 18]);
  });

  test('treats day-of-week 7 as 0 (Sunday)', () => {
    const e = parseCron('0 0 * * 7');
    expect([...e.daysOfWeek]).toEqual([0]);
  });

  test('rejects 6-field expressions', () => {
    expect(() => parseCron('0 0 0 * * *')).toThrow(/5 fields/);
  });

  test('rejects out-of-range values', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('0 24 * * *')).toThrow(/out of range/);
    expect(() => parseCron('0 0 32 * *')).toThrow(/out of range/);
  });
});

describe('nextCronFire', () => {
  test('finds the next firing for daily-at-3am', () => {
    const e = parseCron('0 3 * * *');
    // 2026-05-27T01:00 local → next is same-day 03:00.
    const start = new Date(2026, 4, 27, 1, 0, 0).getTime();
    const next = nextCronFire(e, start);
    expect(next).not.toBeNull();
    const d = new Date(next!);
    expect(d.getHours()).toBe(3);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(27);
  });

  test('wraps to next day if already past', () => {
    const e = parseCron('0 3 * * *');
    // 2026-05-27T04:00 local → next is 2026-05-28T03:00.
    const start = new Date(2026, 4, 27, 4, 0, 0).getTime();
    const next = nextCronFire(e, start);
    expect(next).not.toBeNull();
    const d = new Date(next!);
    expect(d.getDate()).toBe(28);
    expect(d.getHours()).toBe(3);
  });

  test('every-15-min advances by 15 from non-aligned moment', () => {
    const e = parseCron('*/15 * * * *');
    const start = new Date(2026, 4, 27, 12, 7, 0).getTime();
    const next = nextCronFire(e, start);
    expect(next).not.toBeNull();
    const d = new Date(next!);
    expect(d.getMinutes()).toBe(15);
    expect(d.getHours()).toBe(12);
  });

  test('returns null for impossible expression (Feb 30)', () => {
    // 0 0 30 2 * — Feb has no 30th day. Search bounded to 4 years → null.
    const e = parseCron('0 0 30 2 *');
    const start = new Date(2026, 0, 1).getTime();
    expect(nextCronFire(e, start)).toBeNull();
  });
});
