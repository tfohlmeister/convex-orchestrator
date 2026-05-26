export interface BackoffState {
  attempts: number;
  windowStart: number;
}

export const RESTART_DELAYS_MS = [1000, 5000, 30_000, 60_000] as const;
export const MAX_RESTARTS = 5;
export const WINDOW_MS = 10 * 60_000;

export interface BackoffDecision {
  action: 'restart' | 'give-up';
  delayMs: number;
  nextState: BackoffState;
}

export function decideRestart(state: BackoffState, now: number): BackoffDecision {
  const inWindow = now - state.windowStart < WINDOW_MS;
  const attempts = inWindow ? state.attempts : 0;
  const windowStart = inWindow ? state.windowStart : now;

  if (attempts >= MAX_RESTARTS) {
    return {
      action: 'give-up',
      delayMs: 0,
      nextState: { attempts, windowStart },
    };
  }

  const delayMs = RESTART_DELAYS_MS[Math.min(attempts, RESTART_DELAYS_MS.length - 1)]!;
  return {
    action: 'restart',
    delayMs,
    nextState: { attempts: attempts + 1, windowStart },
  };
}
