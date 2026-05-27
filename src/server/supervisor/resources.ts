import { readFile, readdir } from 'node:fs/promises';
import type { ResourceSample } from './types.ts';

export const SAMPLE_INTERVAL_MS = 30_000;
export const RETENTION_MS = 24 * 60 * 60_000;

export interface ResourceReading {
  rssKb: number;
  cpuTicks: number;
  fdCount: number;
}

// Pure parser for the three /proc/<pid>/* values the sampler cares
// about. Extracted from readProcStats so it can be unit-tested with
// synthetic fixtures (real /proc only exists on Linux and varies by
// kernel; testing the parser in isolation is what protects against
// regressions in the lastIndexOf(')') trick that handles comm names
// containing ')' or whitespace).
export function parseProcStats(
  statusText: string,
  statText: string,
  fdCount: number,
): ResourceReading {
  const rssMatch = /VmRSS:\s+(\d+)\s*kB/.exec(statusText);
  const rssKb = rssMatch ? Number(rssMatch[1]) : 0;
  // /proc/<pid>/stat is `pid (comm) state ...`. comm can contain ')'
  // and spaces, so split-by-space breaks for anything but trivial
  // names. lastIndexOf(')') finds the closing paren of the comm field
  // even when comm itself contains ')'; the +2 skips ") " into the
  // state field at index 0 of the post-paren split. utime/stime are
  // fields 14 and 15 in proc(5), which is index 11/12 after the +2
  // slice (state is index 0, ppid is 1, ..., utime is index 11).
  const afterParen = statText.slice(statText.lastIndexOf(')') + 2);
  const fields = afterParen.split(' ');
  const utime = Number(fields[11] ?? 0);
  const stime = Number(fields[12] ?? 0);
  return { rssKb, cpuTicks: utime + stime, fdCount };
}

export async function readProcStats(pid: number): Promise<ResourceReading | null> {
  try {
    const [status, stat, fds] = await Promise.all([
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readdir(`/proc/${pid}/fd`).catch(() => [] as string[]),
    ]);
    return parseProcStats(status, stat, fds.length);
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
