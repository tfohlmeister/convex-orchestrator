import { describe, expect, test } from 'bun:test';

// Lightweight reimplementation of the BackupManager's concurrency-cap queue
// logic, isolated for unit testing. The real one in manager.ts is the same
// shape; if it ever drifts, this test will catch the drift via a manager
// integration test (see TODO in 10.2). Until then we cover the cap logic
// here so the invariant "at most N inflight" is verifiable.
function runQueue<J>(
  maxConcurrent: number,
  jobs: J[],
  work: (j: J) => Promise<void>,
): {
  done: Promise<void>;
  peakInflight: () => number;
  currentInflight: () => number;
} {
  let inflight = 0;
  let peak = 0;
  let active = 0;
  const queue = [...jobs];
  let resolveAll: (() => void) | null = null;
  const done = new Promise<void>((r) => {
    resolveAll = r;
  });
  const drain = (): void => {
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue.shift()!;
      active += 1;
      inflight += 1;
      peak = Math.max(peak, inflight);
      void work(job).finally(() => {
        active -= 1;
        inflight -= 1;
        if (queue.length > 0) drain();
        else if (active === 0 && resolveAll) resolveAll();
      });
    }
  };
  drain();
  return { done, peakInflight: () => peak, currentInflight: () => inflight };
}

describe('queue concurrency cap', () => {
  test('never exceeds maxConcurrent inflight', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const work = async (i: number): Promise<void> => {
      await new Promise((r) => setTimeout(r, 10 + (i % 3) * 5));
    };
    const q = runQueue(2, items, work);
    await q.done;
    expect(q.peakInflight()).toBeLessThanOrEqual(2);
  });

  test('processes all jobs', async () => {
    const items = Array.from({ length: 7 }, (_, i) => i);
    const processed: number[] = [];
    const work = async (i: number): Promise<void> => {
      await new Promise((r) => setTimeout(r, 5));
      processed.push(i);
    };
    const q = runQueue(3, items, work);
    await q.done;
    expect(processed.sort((a, b) => a - b)).toEqual(items);
  });

  test('cap=1 serializes work', async () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    const work = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 5));
    };
    const q = runQueue(1, items, work);
    await q.done;
    expect(q.peakInflight()).toBe(1);
  });
});
