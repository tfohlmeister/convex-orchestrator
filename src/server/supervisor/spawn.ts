import { RotatingLog, logPaths } from './logs.ts';
import type { SpawnConfig } from './types.ts';

export interface SpawnHandle {
  proc: Bun.Subprocess;
  pid: number;
  stdoutLog: RotatingLog;
  stderrLog: RotatingLog;
}

// Verified against the real backend on 2026-08-30. See
// docs/architecture.md § Design decisions worth knowing for the
// env-vars-not-flags contract. Key points:
//   - postgres URL is the positional DB_SPEC, not POSTGRES_URL env. It must
//     carry no db name: postgres-v5 appends the one it derives from
//     --instance-name (dashes to underscores) and rejects a URL with a path.
//   - the database has to exist already; the backend does not create it.
//   - --instance-name, --instance-secret, --do-not-require-ssl must be CLI
//     flags; env vars are ignored.
//   - S3 settings, origins, AWS creds, RUST_LOG, DISABLE_BEACON come via env.
export async function spawnConvex(cfg: SpawnConfig): Promise<SpawnHandle> {
  const paths = logPaths(cfg.logDir, cfg.instance.name);
  const stdoutLog = new RotatingLog(paths.stdout);
  const stderrLog = new RotatingLog(paths.stderr);
  await Promise.all([stdoutLog.ready(), stderrLog.ready()]);

  const cloudOrigin = `${cfg.externalScheme}://${cfg.instance.name}.${cfg.instance.baseDomain}${cfg.externalPortSuffix}`;
  const siteOrigin = `${cfg.externalScheme}://${cfg.instance.name}-site.${cfg.instance.baseDomain}${cfg.externalPortSuffix}`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CONVEX_CLOUD_ORIGIN: cloudOrigin,
    CONVEX_SITE_ORIGIN: siteOrigin,
    S3_ENDPOINT_URL: cfg.s3Endpoint,
    S3_STORAGE_EXPORTS_BUCKET: `${cfg.instance.bucketPrefix}-exports`,
    S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET: `${cfg.instance.bucketPrefix}-snapshot-imports`,
    S3_STORAGE_MODULES_BUCKET: `${cfg.instance.bucketPrefix}-modules`,
    S3_STORAGE_FILES_BUCKET: `${cfg.instance.bucketPrefix}-files`,
    S3_STORAGE_SEARCH_BUCKET: `${cfg.instance.bucketPrefix}-search`,
    AWS_ACCESS_KEY_ID: cfg.s3AccessKey,
    AWS_SECRET_ACCESS_KEY: cfg.s3SecretKey,
    AWS_REGION: cfg.s3Region,
    AWS_S3_FORCE_PATH_STYLE: 'true',
    // MinIO doesn't ship with a KMS, so Convex's default SSE-KMS multipart
    // uploads fail with "NotImplemented: Server side encryption specified
    // but KMS is not configured". Disable SSE entirely — at-rest encryption
    // for the MinIO volume is a separate concern (host fs encryption,
    // MinIO_KMS_AUTO_ENCRYPTION, etc.) and not the orchestrator's call.
    AWS_S3_DISABLE_SSE: 'true',
    DISABLE_BEACON: 'true',
    RUST_LOG: process.env.CONVEX_RUST_LOG ?? 'info',
  };

  const args = [
    cfg.binaryPath,
    cfg.databaseUrl,
    '-d',
    'postgres-v5',
    '-p',
    String(cfg.instance.cloudPort),
    '--site-proxy-port',
    String(cfg.instance.sitePort),
    '-i',
    cfg.bindAddress,
    '--s3-storage',
    '--do-not-require-ssl',
    '--instance-name',
    cfg.instance.name,
    '--instance-secret',
    cfg.instance.instanceSecret,
  ];

  const proc = Bun.spawn(args, {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  pipeToLog(proc.stdout as ReadableStream<Uint8Array>, stdoutLog).catch((err: unknown) => {
    cfg.onPipeError?.('stdout', err instanceof Error ? err : new Error(String(err)));
  });
  pipeToLog(proc.stderr as ReadableStream<Uint8Array>, stderrLog).catch((err: unknown) => {
    cfg.onPipeError?.('stderr', err instanceof Error ? err : new Error(String(err)));
  });

  return {
    proc,
    pid: proc.pid,
    stdoutLog,
    stderrLog,
  };
}

async function pipeToLog(stream: ReadableStream<Uint8Array>, log: RotatingLog): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) await log.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    await log.close();
  }
}
