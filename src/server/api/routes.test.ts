import { describe, expect, test } from 'bun:test';
import { deriveCpuCores } from './routes.ts';
import type { ResourceSample } from '../supervisor/types.ts';

function s(takenAt: number, cpuTicks: number, rssKb = 1000, fdCount = 10): ResourceSample {
  return { instanceName: 'x', takenAt, cpuTicks, rssKb, fdCount };
}

describe('deriveCpuCores', () => {
  const CLK = 100;

  test('first row gets null', () => {
    const out = deriveCpuCores([s(0, 0)], CLK);
    expect(out[0]!.cpuCores).toBeNull();
  });

  test('monotonic ticks yield positive cpuCores', () => {
    // 1000 ticks across 10 seconds at 100 Hz = 1.0 cores
    const out = deriveCpuCores([s(0, 0), s(10_000, 1000)], CLK);
    expect(out[1]!.cpuCores).toBeCloseTo(1.0, 5);
  });

  test('partial-core usage', () => {
    // 30 ticks across 1 second at 100 Hz = 0.3 cores
    const out = deriveCpuCores([s(0, 0), s(1_000, 30)], CLK);
    expect(out[1]!.cpuCores).toBeCloseTo(0.3, 5);
  });

  test('counter reset yields null', () => {
    // Second sample's cpuTicks lower than first → backend restarted
    const out = deriveCpuCores([s(0, 500), s(30_000, 100)], CLK);
    expect(out[1]!.cpuCores).toBeNull();
  });

  test('single-sample series → all null', () => {
    const out = deriveCpuCores([s(0, 0)], CLK);
    expect(out.every((p) => p.cpuCores === null)).toBe(true);
  });

  test('three-sample series produces two computed cores values', () => {
    const out = deriveCpuCores([s(0, 0), s(30_000, 300), s(60_000, 600)], CLK);
    expect(out[0]!.cpuCores).toBeNull();
    expect(out[1]!.cpuCores).toBeCloseTo(0.1, 5);
    expect(out[2]!.cpuCores).toBeCloseTo(0.1, 5);
  });

  test('zero elapsed time → null (avoid div-by-zero)', () => {
    const out = deriveCpuCores([s(0, 0), s(0, 100)], CLK);
    expect(out[1]!.cpuCores).toBeNull();
  });
});
