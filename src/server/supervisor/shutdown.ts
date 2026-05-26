const GRACE_MS = 10_000;

export interface StoppableProcess {
  pid: number;
  kill(signal: NodeJS.Signals | number): boolean | void;
  readonly exited: Promise<number | null>;
}

export async function gracefulStop(proc: StoppableProcess, graceMs = GRACE_MS): Promise<void> {
  try {
    proc.kill('SIGTERM');
  } catch {
    return;
  }
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), graceMs),
  );
  const result = await Promise.race([proc.exited.then(() => 'exited' as const), timeout]);
  if (result === 'timeout') {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already dead */
    }
    await proc.exited;
  }
}

export async function stopAll(
  procs: Iterable<StoppableProcess>,
  graceMs = GRACE_MS,
): Promise<void> {
  await Promise.all(Array.from(procs, (p) => gracefulStop(p, graceMs)));
}
