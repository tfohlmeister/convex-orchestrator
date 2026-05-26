import { readFile, readdir } from 'node:fs/promises';
import type { ResourceSample } from './types.ts';

export const SAMPLE_INTERVAL_MS = 30_000;
export const RETENTION_MS = 24 * 60 * 60_000;

export interface ResourceReading {
  rssKb: number;
  cpuTicks: number;
  fdCount: number;
}

export async function readProcStats(pid: number): Promise<ResourceReading | null> {
  try {
    const [status, stat, fds] = await Promise.all([
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readdir(`/proc/${pid}/fd`).catch(() => [] as string[]),
    ]);
    const rssMatch = /VmRSS:\s+(\d+)\s*kB/.exec(status);
    const rssKb = rssMatch ? Number(rssMatch[1]) : 0;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = Number(fields[11] ?? 0);
    const stime = Number(fields[12] ?? 0);
    return { rssKb, cpuTicks: utime + stime, fdCount: fds.length };
  } catch {
    return null;
  }
}

export interface ResourceSink {
  insert(sample: ResourceSample): void;
  pruneOlderThan(cutoffMs: number): void;
}

export class ResourceSampler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sink: ResourceSink,
    private readonly getPids: () => Map<string, number>,
    private readonly intervalMs = SAMPLE_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    const now = Date.now();
    for (const [name, pid] of this.getPids()) {
      const reading = await readProcStats(pid);
      if (!reading) continue;
      this.sink.insert({
        instanceName: name,
        takenAt: now,
        rssKb: reading.rssKb,
        cpuTicks: reading.cpuTicks,
        fdCount: reading.fdCount,
      });
    }
    this.sink.pruneOlderThan(now - RETENTION_MS);
  }
}
