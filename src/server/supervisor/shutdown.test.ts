import { describe, expect, test } from 'bun:test';
import { gracefulStop, stopAll, type StoppableProcess } from './shutdown.ts';

// Fake a Bun.Subprocess that exits when we resolve `exit`. The test
// drives the lifecycle by hand so we can observe SIGTERM/SIGKILL
// without spinning up a real child.
function fakeProc(opts: { exitDelayMs?: number } = {}): {
  proc: StoppableProcess;
  signals: NodeJS.Signals[];
  resolveExit: () => void;
} {
  const signals: NodeJS.Signals[] = [];
  let resolveExit!: () => void;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = () => resolve(0);
  });
  const proc: StoppableProcess = {
    pid: 1234,
    kill(sig) {
      signals.push(sig as NodeJS.Signals);
      if (opts.exitDelayMs == null) {
        // Default: SIGTERM (or any signal) exits the process immediately.
        resolveExit();
      } else if (signals.length === 1) {
        // First signal observed (SIGTERM) — schedule a delayed exit so
        // the test can observe whether SIGKILL is sent first.
        setTimeout(resolveExit, opts.exitDelayMs);
      }
      return true;
    },
    exited,
  };
  return { proc, signals, resolveExit };
}

describe('gracefulStop', () => {
  test('sends SIGTERM and resolves when the process exits before the grace window', async () => {
    const { proc, signals } = fakeProc(); // exits immediately on first signal
    await gracefulStop(proc, 1_000);
    expect(signals).toEqual(['SIGTERM']);
  });

  test('escalates to SIGKILL when the process does not exit within the grace window', async () => {
    // Process ignores SIGTERM, exits only after the grace timer fires.
    const { proc, signals, resolveExit } = fakeProc({ exitDelayMs: 10_000 });
    const done = gracefulStop(proc, 25);
    // Give the race a few ticks to fire the timeout branch.
    await new Promise((r) => setTimeout(r, 60));
    // SIGTERM first (start), then SIGKILL after grace.
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    // Let the proc actually exit so the await above can complete.
    resolveExit();
    await done;
  });

  test('returns quietly when kill() throws (process already dead)', async () => {
    const exited = Promise.resolve(0);
    const proc: StoppableProcess = {
      pid: 1,
      kill: () => {
        throw new Error('ESRCH');
      },
      exited,
    };
    const result = await gracefulStop(proc, 25);
    expect(result).toBeUndefined();
  });
});

describe('stopAll', () => {
  test('stops every process in parallel and awaits them all', async () => {
    const a = fakeProc();
    const b = fakeProc();
    const c = fakeProc();
    await stopAll([a.proc, b.proc, c.proc], 25);
    expect(a.signals).toEqual(['SIGTERM']);
    expect(b.signals).toEqual(['SIGTERM']);
    expect(c.signals).toEqual(['SIGTERM']);
  });
});
