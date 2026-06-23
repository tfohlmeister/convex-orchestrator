import { describe, expect, test } from 'bun:test';
import { CronTicker, msUntilNextMinute } from './cron-ticker.ts';
import type { Logger } from '../logger.ts';

function captureLogger(): { logger: Logger; errors: unknown[] } {
  const errors: unknown[] = [];
  const noop = (): void => undefined;
  const logger = {
    info: noop,
    warn: noop,
    error: (obj: unknown) => errors.push(obj),
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => logger,
  } as unknown as Logger;
  return { logger, errors };
}

// 2026-06-23 local time, epoch-ms via Date so the test matches the ticker's
// local-time cron interpretation regardless of the runner's timezone.
const at = (h: number, m: number): number => new Date(2026, 5, 23, h, m, 0, 0).getTime();

describe('CronTicker.due', () => {
  test('arms on first sight without firing, fires on the due minute', () => {
    const { logger } = captureLogger();
    const t = new CronTicker(logger, 'test');
    expect(t.due('a', '0 4 * * *', at(3, 59))).toBe(false);
    expect(t.due('a', '0 4 * * *', at(4, 0))).toBe(true);
  });

  test('does not fire twice in the same due minute (advances next-fire)', () => {
    const { logger } = captureLogger();
    const t = new CronTicker(logger, 'test');
    t.due('a', '0 4 * * *', at(3, 59));
    expect(t.due('a', '0 4 * * *', at(4, 0))).toBe(true);
    expect(t.due('a', '0 4 * * *', at(4, 0))).toBe(false);
  });

  test('fires when first seen exactly on the due minute (now-60s lookback)', () => {
    const { logger } = captureLogger();
    const t = new CronTicker(logger, 'test');
    // No prior arming tick — first call lands on the cron minute and must fire.
    expect(t.due('a', '0 4 * * *', at(4, 0))).toBe(true);
  });

  test('logs once and returns false for an invalid cron', () => {
    const { logger, errors } = captureLogger();
    const t = new CronTicker(logger, 'restart');
    expect(t.due('a', 'not a cron', at(4, 0))).toBe(false);
    expect(errors.length).toBe(1);
  });

  test('re-parses when the raw expression changes', () => {
    const { logger } = captureLogger();
    const t = new CronTicker(logger, 'test');
    t.due('a', '0 4 * * *', at(3, 59));
    // Switch to a 02:30 schedule; the 04:00 next-fire must be recomputed.
    expect(t.due('a', '30 2 * * *', at(2, 29))).toBe(false);
    expect(t.due('a', '30 2 * * *', at(2, 30))).toBe(true);
  });

  test('tracks instances independently', () => {
    const { logger } = captureLogger();
    const t = new CronTicker(logger, 'test');
    t.due('a', '0 4 * * *', at(3, 59));
    t.due('b', '30 2 * * *', at(3, 59));
    expect(t.due('a', '0 4 * * *', at(4, 0))).toBe(true);
    expect(t.due('b', '30 2 * * *', at(4, 0))).toBe(false);
  });

  test('dropInstance re-arms from scratch', () => {
    const { logger } = captureLogger();
    const t = new CronTicker(logger, 'test');
    t.due('a', '0 4 * * *', at(3, 59));
    t.dropInstance('a');
    // After drop the schedule is rebuilt and still fires on the due minute.
    expect(t.due('a', '0 4 * * *', at(4, 0))).toBe(true);
  });
});

describe('msUntilNextMinute', () => {
  test('returns the ms remaining to the next minute boundary', () => {
    expect(msUntilNextMinute(0)).toBe(60_000);
    expect(msUntilNextMinute(59_000)).toBe(1_000);
    expect(msUntilNextMinute(60_000)).toBe(60_000);
  });
});
