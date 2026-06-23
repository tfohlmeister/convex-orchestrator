import { readdir, readFile } from 'node:fs/promises';

// A convex-local-backend spawns a Node "executor" subprocess (the
// /tmp/.tmpXXX/local.cjs isolate runtime) to run Node actions. That executor
// does NOT die when its parent backend receives SIGTERM: it gets reparented
// to PID 1 and keeps running, holding its (often multi-GB) heap. So stopping
// or restarting a backend the naive way leaks the executor's memory — the
// exact thing a scheduled restart is meant to reclaim. To reap it we capture
// the backend's descendant PIDs *before* the parent dies (while the ppid
// links still point at it) and SIGKILL any survivors afterwards.
//
// Linux-only (reads /proc). On any other platform, or any read error, the
// helpers degrade to a no-op so the supervisor keeps working in dev/tests —
// reaping is a best-effort cleanup, never a correctness precondition for the
// stop itself.

export interface ProcReader {
  // Lists the numeric PID entries under /proc.
  listPids(): Promise<number[]>;
  // Returns the parent PID for `pid`, or null if it can't be read.
  parentOf(pid: number): Promise<number | null>;
}

const fsProcReader: ProcReader = {
  async listPids(): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir('/proc');
    } catch {
      return [];
    }
    const pids: number[] = [];
    for (const e of entries) {
      const pid = Number(e);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
    return pids;
  },
  async parentOf(pid: number): Promise<number | null> {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return parsePpidFromStat(stat);
    } catch {
      return null;
    }
  },
};

// /proc/<pid>/stat format: "pid (comm) state ppid ...". The comm field is
// wrapped in parens and may itself contain spaces or parens (e.g. a process
// named "(sd-pam)"), so we anchor on the LAST ')' and read ppid as the
// second whitespace-separated field after it (the first is the state char).
export function parsePpidFromStat(stat: string): number | null {
  const rparen = stat.lastIndexOf(')');
  if (rparen < 0) return null;
  const rest = stat
    .slice(rparen + 1)
    .trim()
    .split(/\s+/);
  // rest[0] = state, rest[1] = ppid
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

// Returns every descendant PID of `root` (children, grandchildren, …),
// excluding `root` itself. Best-effort: returns [] on non-Linux or read
// failure.
export async function listDescendants(
  root: number,
  reader: ProcReader = fsProcReader,
): Promise<number[]> {
  if (process.platform !== 'linux' && reader === fsProcReader) return [];
  const pids = await reader.listPids();
  if (pids.length === 0) return [];

  const childrenOf = new Map<number, number[]>();
  await Promise.all(
    pids.map(async (pid) => {
      const ppid = await reader.parentOf(pid);
      if (ppid == null) return;
      const arr = childrenOf.get(ppid);
      if (arr) arr.push(pid);
      else childrenOf.set(ppid, [pid]);
    }),
  );

  const out: number[] = [];
  const stack = [root];
  const seen = new Set<number>([root]);
  while (stack.length > 0) {
    const p = stack.pop()!;
    for (const child of childrenOf.get(p) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

// SIGKILL each PID, swallowing "process already gone" (ESRCH) and any other
// per-PID error so one dead PID never blocks reaping the rest. Returns the
// PIDs to which the signal was actually delivered (for logging).
export function killAll(
  pids: number[],
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(pid, signal),
): number[] {
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      /* already gone or not permitted — nothing to reap */
    }
  }
  return killed;
}
