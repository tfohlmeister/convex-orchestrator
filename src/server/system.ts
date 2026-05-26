// Resolve the host's CLK_TCK once at import time so consumers can convert
// `cpu_ticks` deltas (from /proc/<pid>/stat) to wall-clock seconds. Falls
// back to 100 on any failure (the standard Linux x86_64 value since forever).

let cached: number | null = null;

export function getClkTck(): number {
  if (cached !== null) return cached;
  try {
    const proc = Bun.spawnSync(['getconf', 'CLK_TCK']);
    if (proc.exitCode === 0) {
      const parsed = parseInt(proc.stdout.toString().trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        cached = parsed;
        return cached;
      }
    }
  } catch {
    /* fall through to default */
  }
  cached = 100;
  return cached;
}
