import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export interface ConvexCliConfig {
  // Self-hosted Convex deployment URL (e.g. http://127.0.0.1:13210).
  deploymentUrl: string;
  // Admin key for the deployment.
  adminKey: string;
  // Path to the `convex` CLI binary (or just "convex" if on PATH).
  convexCli?: string;
  // Optional NODE override; defaults to whatever PATH resolves.
  nodeBin?: string;
}

export interface RunExportArgs extends ConvexCliConfig {
  // Where the resulting `.zip` should land. The CLI writes to this exact
  // path (uses --path).
  outputPath: string;
  // Optional timeout in ms. Defaults to 30 minutes — matches the
  // `BACKUP_EXPORT_TIMEOUT_MINUTES` default.
  timeoutMs?: number;
  // Optional callback for incremental stdout/stderr lines, useful for
  // surfacing progress to the UI.
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface RunExportResult {
  success: boolean;
  sizeBytes: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface RunImportArgs extends ConvexCliConfig {
  inputPath: string;
  timeoutMs?: number;
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface RunImportResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

// Spawns `<convexCli> export --include-file-storage --path <out>` against
// the given deployment. Streams stdout/stderr to onLog for live progress and
// accumulates them for the caller's audit log. Resolves regardless of exit
// status; the caller inspects `success`.
export async function runExport(args: RunExportArgs): Promise<RunExportResult> {
  const result = await runConvex({
    cli: args.convexCli ?? process.env.CONVEX_CLI ?? 'convex',
    nodeBin: args.nodeBin,
    deploymentUrl: args.deploymentUrl,
    adminKey: args.adminKey,
    timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // --url + --admin-key intentionally omitted here. The CONVEX_SELF_HOSTED_*
    // env vars below tell the CLI the same thing, but they don't appear in
    // /proc/<pid>/cmdline. With both env and flags set the CLI prefers the
    // flags, so passing them as argv would leak the admin key to any process
    // that can ps the orchestrator.
    cliArgs: ['export', '--include-file-storage', '--path', args.outputPath],
    onLog: args.onLog,
  });

  let sizeBytes = 0;
  if (result.success) {
    try {
      sizeBytes = (await stat(args.outputPath)).size;
    } catch {
      // CLI claimed success but the file is missing — surface as failure
      // so the caller doesn't upload a phantom zip.
      return { ...result, success: false, sizeBytes: 0 };
    }
  }
  return { ...result, sizeBytes };
}

// Spawns `<convexCli> import --replace-all --include-file-storage <in>`.
// --replace-all is destructive: every restore path goes through this, so the
// orchestrator MUST have created a pre-restore backup before invoking it.
export async function runImport(args: RunImportArgs): Promise<RunImportResult> {
  return runConvex({
    cli: args.convexCli ?? process.env.CONVEX_CLI ?? 'convex',
    nodeBin: args.nodeBin,
    deploymentUrl: args.deploymentUrl,
    adminKey: args.adminKey,
    timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // Same env-only credential delivery as runExport; see comment there.
    cliArgs: [
      'import',
      '--replace-all',
      // Storage is auto-detected from the zip contents — there is no
      // --include-file-storage flag on import. -y skips the destructive
      // confirmation prompt (we already gated on the orchestrator's own
      // "type instance name" confirm-dialog upstream).
      '-y',
      args.inputPath,
    ],
    onLog: args.onLog,
  });
}

interface SpawnArgs {
  cli: string;
  nodeBin: string | undefined;
  deploymentUrl: string;
  adminKey: string;
  cliArgs: string[];
  timeoutMs: number;
  onLog: ((stream: 'stdout' | 'stderr', line: string) => void) | undefined;
}

interface SpawnResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function runConvex(args: SpawnArgs): Promise<SpawnResult> {
  return new Promise((resolve) => {
    // CI=1 disables convex CLI's analytics prompt and any TTY-only
    // niceties. The CLI has no --yes flag (it auto-confirms when stdin
    // isn't a TTY, which it isn't here).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CONVEX_SELF_HOSTED_URL: args.deploymentUrl,
      CONVEX_SELF_HOSTED_ADMIN_KEY: args.adminKey,
      CI: '1',
    };
    // Run from a directory that contains a stub package.json with `convex`
    // in dependencies — the CLI runs `ensureHasConvexDependency` even in
    // self-hosted --url/--admin-key mode (Convex CLI 1.18.2). Falls back
    // to cwd when CONVEX_CLI_CWD isn't set (dev outside docker).
    const cwd = process.env.CONVEX_CLI_CWD ?? process.cwd();
    const proc = spawn(args.cli, args.cliArgs, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 10_000);
    }, args.timeoutMs);

    const onChunk = (which: 'stdout' | 'stderr', buf: Buffer): void => {
      const text = buf.toString('utf8');
      if (which === 'stdout') stdout += text;
      else stderr += text;
      if (args.onLog) {
        for (const line of text.split('\n')) {
          if (line.length > 0) args.onLog(which, line);
        }
      }
    };
    proc.stdout.on('data', (b: Buffer) => onChunk('stdout', b));
    proc.stderr.on('data', (b: Buffer) => onChunk('stderr', b));

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({
        success: false,
        stdout,
        stderr: `${stderr}\nspawn error: ${err.message}`,
        exitCode: null,
        signal: null,
        timedOut: false,
      });
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        success: code === 0 && !timedOut,
        stdout,
        stderr,
        exitCode: code,
        signal: signal as NodeJS.Signals | null,
        timedOut,
      });
    });
  });
}
