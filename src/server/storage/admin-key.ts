export interface AdminKeyTools {
  binaryPath: string;
}

export async function generateAdminKey(
  tools: AdminKeyTools,
  instanceName: string,
  instanceSecret: string,
): Promise<string> {
  const proc = Bun.spawn(
    [
      tools.binaryPath,
      'keygen',
      'admin-key',
      '--instance-name',
      instanceName,
      '--instance-secret',
      instanceSecret,
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`keygen admin-key exited ${exitCode}: ${stderr.trim()}`);
  }
  // stdout is the key alone, one line, with nothing on stderr.
  const key = stdout.trim();
  if (!key.startsWith(`${instanceName}|`)) {
    throw new Error(`keygen admin-key produced unexpected output: ${key.slice(0, 64)}…`);
  }
  return key;
}
