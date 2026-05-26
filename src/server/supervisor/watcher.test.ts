import { describe, expect, test } from 'bun:test';
import { MAX_RESTARTS, RESTART_DELAYS_MS, WINDOW_MS, decideRestart } from './watcher.ts';

describe('decideRestart', () => {
  const t0 = 1_700_000_000_000;

  test('first attempt uses 1s delay', () => {
    const d = decideRestart({ attempts: 0, windowStart: t0 }, t0);
    expect(d.action).toBe('restart');
    expect(d.delayMs).toBe(RESTART_DELAYS_MS[0]);
    expect(d.nextState.attempts).toBe(1);
  });

  test('escalates through delay table', () => {
    const seen: number[] = [];
    let state = { attempts: 0, windowStart: t0 };
    for (let i = 0; i < MAX_RESTARTS; i++) {
      const d = decideRestart(state, t0 + i * 1000);
      seen.push(d.delayMs);
      state = d.nextState;
    }
    expect(seen).toEqual([1000, 5000, 30_000, 60_000, 60_000]);
  });

  test('gives up after MAX_RESTARTS within window', () => {
    let state = { attempts: 0, windowStart: t0 };
    for (let i = 0; i < MAX_RESTARTS; i++) {
      state = decideRestart(state, t0).nextState;
    }
    const final = decideRestart(state, t0 + 60_000);
    expect(final.action).toBe('give-up');
  });

  test('resets attempts when window expires', () => {
    let state = { attempts: 0, windowStart: t0 };
    for (let i = 0; i < MAX_RESTARTS; i++) {
      state = decideRestart(state, t0).nextState;
    }
    const afterWindow = decideRestart(state, t0 + WINDOW_MS + 1);
    expect(afterWindow.action).toBe('restart');
    expect(afterWindow.delayMs).toBe(RESTART_DELAYS_MS[0]);
    expect(afterWindow.nextState.attempts).toBe(1);
  });
});
