export interface AdminKeyTools {
  binaryPath: string;
}

export async function generateAdminKey(
  tools: AdminKeyTools,
  instanceName: string,
  instanceSecret: string,
): Promise<string> {
  const proc = Bun.spawn([tools.binaryPath, instanceName, instanceSecret], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`generate_key exited ${exitCode}: ${stderr.trim()}`);
  }
  // stdout is the key alone, one line. stderr carries the decorative "Admin key:" banner.
  const key = stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!key.startsWith(`${instanceName}|`)) {
    throw new Error(`generate_key produced unexpected output: ${key.slice(0, 64)}…`);
  }
  return key;
}
