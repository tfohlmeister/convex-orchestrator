import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Logger } from '../logger.ts';
import type { Config } from '../config.ts';
import type { AuditRepo, BackupRepo, InstanceRepo, Backup } from '../db/repos.ts';
import type { MinioStorage } from '../storage/minio.ts';
import type { Instance } from '../supervisor/types.ts';
import { runExport } from './cli.ts';
import { streamFileToBackup, hashFile } from './upload.ts';
import { CronTicker, msUntilNextMinute } from '../scheduling/cron-ticker.ts';

export interface BackupManagerDeps {
  config: Config;
  logger: Logger;
  instances: InstanceRepo;
  backups: BackupRepo;
  audit: AuditRepo;
  minio: MinioStorage;
  // Used by the scheduler to enumerate currently-running instances each tick.
  listInstances: () => Instance[];
  // Used by the stuck-detection worker so it can ask for a restart.
  forceRestartBackend: (name: string, actor: string) => Promise<void>;
  // Internal URL the orchestrator uses to talk to its own running backends.
  // The supervisor binds to BACKUP_INTERNAL_HOST:cloudPort.
  internalHost: string;
}

interface QueuedJob {
  // Backup row id, pre-allocated by the enqueueing caller so the API
  // response and the audit log carry the same id the row will eventually
  // have. The worker uses this id when inserting the row.
  id: string;
  instance: Instance;
  source: 'auto' | 'manual' | 'pre-restore';
  // For pre-restore: resolve once complete (success path), reject on failure.
  resolve?: (backup: Backup) => void;
  reject?: (err: Error) => void;
  // Track expression source for log clarity.
  triggerReason: string;
}

// Coarse-grained version stamp included in backup rows for forensics. The
// real Convex binary version is the immutable Docker ARG CONVEX_VERSION but
// we read it lazily from env to avoid plumbing it everywhere.
// Exported so the manual-upload path in restore.ts can stamp rows with
// the same identifier; otherwise the two paths would drift if anyone
// ever changed the source (env var → binary read, etc.).
export function convexVersionStamp(): string {
  return process.env.CONVEX_VERSION ?? 'unknown';
}

export class BackupManager {
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private stuckTimer: ReturnType<typeof setInterval> | null = null;
  private queue: QueuedJob[] = [];
  private activeCount = 0;
  // Cron parse cache + next-fire bookkeeping for the auto-backup schedule.
  private ticker: CronTicker;
  // Running jobs are tracked by backup id so the stuck-detector can find
  // them and the API endpoint can check liveness.
  private inflight = new Set<string>();

  constructor(private readonly deps: BackupManagerDeps) {
    this.ticker = new CronTicker(deps.logger, 'backup');
  }

  // Called from Orchestrator.delete to purge per-instance scheduler state.
  // Without this, a delete + recreate of the same name within the same
  // process inherits the stale next-fire timestamp, silently skipping the
  // fresh instance's first auto-backup window.
  dropInstance(name: string): void {
    this.ticker.dropInstance(name);
  }

  start(): void {
    if (!this.deps.config.BACKUP_SCHEDULER_ENABLED) {
      this.deps.logger.warn(
        'BACKUP_SCHEDULER_ENABLED=false — automatic backups disabled. Manual API still works.',
      );
      return;
    }
    if (this.schedulerTimer) return;
    // One scheduler tick per minute.
    this.schedulerTimer = setInterval(() => {
      void this.schedulerTick();
    }, 60_000);
    // Mark the first tick on next 0-second boundary so it aligns with cron
    // minute resolution.
    setTimeout(() => void this.schedulerTick(), msUntilNextMinute());

    this.cleanupTimer = setInterval(() => {
      void this.exportBlobCleanupTick();
    }, this.deps.config.EXPORT_BLOB_CLEANUP_INTERVAL_MS);

    // Retention sweep ticks hourly; the actual deletion only runs once per
    // day during BACKUP_RETENTION_HOUR.
    this.retentionTimer = setInterval(() => {
      void this.retentionTick();
    }, 60 * 60_000);

    // Stuck-detector ticks once a minute alongside scheduler.
    this.stuckTimer = setInterval(() => {
      void this.stuckDetectorTick();
    }, 60_000);
  }

  stop(): void {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.stuckTimer) clearInterval(this.stuckTimer);
    this.schedulerTimer = null;
    this.cleanupTimer = null;
    this.retentionTimer = null;
    this.stuckTimer = null;
  }

  // Enqueue a one-off manual backup. Returns immediately with the backup id;
  // status changes are observable via BackupRepo.
  enqueueManual(instance: Instance, actor: string): string {
    const id = this.allocateId();
    this.queue.push({
      id,
      instance,
      source: 'manual',
      triggerReason: `manual by ${actor}`,
    });
    this.deps.audit.record({
      at: Date.now(),
      actor,
      action: 'backup_started',
      instanceName: instance.name,
      details: `source=manual id=${id}`,
    });
    void this.tryDrainQueue();
    return id;
  }

  // Synchronous pre-restore backup. The restore flow waits for it; if it
  // fails the whole restore is aborted with the failure reason.
  async runPreRestoreBackup(instance: Instance, actor: string): Promise<Backup> {
    const id = this.allocateId();
    return new Promise((resolve, reject) => {
      this.queue.unshift({
        id,
        instance,
        source: 'pre-restore',
        triggerReason: `pre-restore by ${actor}`,
        resolve,
        reject,
      });
      this.deps.audit.record({
        at: Date.now(),
        actor,
        action: 'backup_started',
        instanceName: instance.name,
        details: `source=pre-restore id=${id}`,
      });
      void this.tryDrainQueue();
    });
  }

  // Re-enable an instance's auto-schedule after suspension or after the
  // operator flips the enabled toggle back on.
  resumeAutoBackups(instanceName: string, actor: string): void {
    this.deps.instances.updateBackupConfig(instanceName, {
      enabled: true,
      suspended: false,
    });
    this.ticker.dropInstance(instanceName);
    this.deps.audit.record({
      at: Date.now(),
      actor,
      action: 'backup_auto_resumed',
      instanceName,
    });
  }

  private allocateId(): string {
    return randomUUID();
  }

  private async schedulerTick(): Promise<void> {
    const now = Date.now();
    for (const inst of this.deps.listInstances()) {
      if (inst.status !== 'running') continue;
      const enabled = inst.backupEnabled ?? true;
      if (!enabled || inst.backupSuspended) continue;
      const raw = inst.backupCron ?? this.deps.config.BACKUP_DEFAULT_CRON;
      if (!this.ticker.due(inst.name, raw, now)) continue;
      // Due — enqueue an auto backup (the ticker already advanced next-fire).
      this.queue.push({
        id: this.allocateId(),
        instance: inst,
        source: 'auto',
        triggerReason: `cron ${raw}`,
      });
    }
    await this.tryDrainQueue();
  }

  private async tryDrainQueue(): Promise<void> {
    while (this.activeCount < this.deps.config.BACKUP_MAX_CONCURRENT && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      this.activeCount += 1;
      void this.runJob(job)
        .catch((err: unknown) => {
          this.deps.logger.error(
            { name: job.instance.name, err: errMsg(err) },
            'backup job crashed',
          );
          if (job.reject) job.reject(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          this.activeCount -= 1;
          // Newly freed slot — try to pull the next job synchronously.
          void this.tryDrainQueue();
        });
    }
  }

  private async runJob(job: QueuedJob): Promise<void> {
    const id = job.id;
    const startedAt = Date.now();
    const tempPath = join(this.deps.config.BACKUP_WORK_DIR, `${job.instance.name}_${id}.zip`);
    await mkdir(this.deps.config.BACKUP_WORK_DIR, { recursive: true });

    const row: Backup = {
      id,
      instanceName: job.instance.name,
      source: job.source,
      startedAt,
      completedAt: null,
      status: 'running',
      targetKey: null,
      sizeBytes: null,
      sha256: null,
      convexVersion: convexVersionStamp(),
      errorMessage: null,
    };
    this.deps.backups.insert(row);
    this.inflight.add(id);
    this.deps.logger.info(
      { name: job.instance.name, id, source: job.source, reason: job.triggerReason },
      'backup starting',
    );

    try {
      const exp = await runExport({
        deploymentUrl: this.deploymentUrl(job.instance),
        adminKey: job.instance.adminKey,
        outputPath: tempPath,
        convexCli: this.deps.config.CONVEX_CLI,
        timeoutMs: this.deps.config.BACKUP_EXPORT_TIMEOUT_MINUTES * 60_000,
      });
      if (!exp.success) {
        const msg = exp.timedOut
          ? `convex export timed out after ${this.deps.config.BACKUP_EXPORT_TIMEOUT_MINUTES} min`
          : `convex export failed (exit=${exp.exitCode ?? 'null'}, signal=${exp.signal ?? 'none'})`;
        await this.finalizeFailure(id, job, msg, exp.stderr);
        await rmQuiet(tempPath);
        return;
      }

      const isoStamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
      const key = `${job.instance.name}_${isoStamp}_v${convexVersionStamp()}_${id}.zip`;
      const { sizeBytes, sha256 } = await streamFileToBackup(
        this.deps.minio,
        job.instance.bucketPrefix,
        key,
        tempPath,
      );
      // Verify round-trip: re-hash the file from disk (cheap) before marking
      // complete. Note we hash the local file twice (once during upload via
      // streamFileToBackup, once here). Re-reading the MinIO object would be
      // a stronger check but doubles network egress. The local re-hash
      // catches accidental local mutation between hashing and upload close,
      // which is the realistic failure mode.
      const verify = await hashFile(tempPath);
      if (verify !== sha256) {
        await this.finalizeFailure(
          id,
          job,
          `sha256 mismatch after upload: ${verify} vs ${sha256}`,
          '',
          { status: 'corrupt' },
        );
        await rmQuiet(tempPath);
        return;
      }

      const completedAt = Date.now();
      this.deps.backups.updateStatus(id, {
        status: 'complete',
        completedAt,
        targetKey: key,
        sizeBytes,
        sha256,
      });
      this.deps.audit.record({
        at: completedAt,
        actor: 'scheduler',
        action: 'backup_completed',
        instanceName: job.instance.name,
        details: `id=${id} source=${job.source} size=${sizeBytes} sha256=${sha256.slice(0, 12)}`,
      });
      this.deps.logger.info(
        { name: job.instance.name, id, sizeBytes, ms: completedAt - startedAt },
        'backup complete',
      );
      await rmQuiet(tempPath);

      const finalRow = this.deps.backups.get(id);
      if (job.resolve && finalRow) job.resolve(finalRow);
    } catch (err: unknown) {
      await this.finalizeFailure(id, job, errMsg(err), '');
      await rmQuiet(tempPath);
    } finally {
      this.inflight.delete(id);
    }
  }

  private async finalizeFailure(
    id: string,
    job: QueuedJob,
    message: string,
    stderr: string,
    extras: { status?: 'failed' | 'corrupt' } = {},
  ): Promise<void> {
    const status = extras.status ?? 'failed';
    const completedAt = Date.now();
    this.deps.backups.updateStatus(id, {
      status,
      completedAt,
      errorMessage: stderr.length > 0 ? `${message}\n${stderr}`.slice(0, 4_000) : message,
    });
    this.deps.audit.record({
      at: completedAt,
      actor: 'scheduler',
      action: 'backup_failed',
      instanceName: job.instance.name,
      details: `id=${id} source=${job.source} reason=${truncate(message, 200)}`,
    });
    this.deps.logger.error({ name: job.instance.name, id, message }, 'backup failed');

    // 3-strikes-and-out for auto backups: suspend the schedule so a broken
    // instance doesn't burn CPU until the operator looks at it.
    if (job.source === 'auto') {
      const fails = this.deps.backups.consecutiveAutoFailures(job.instance.name);
      if (fails >= this.deps.config.BACKUP_MAX_CONSECUTIVE_FAILURES) {
        this.deps.instances.updateBackupConfig(job.instance.name, { suspended: true });
        this.ticker.dropInstance(job.instance.name);
        this.deps.audit.record({
          at: completedAt,
          actor: 'scheduler',
          action: 'backup_auto_suspended',
          instanceName: job.instance.name,
          details: `consecutive_failures=${fails}`,
        });
      }
    }

    if (job.reject) job.reject(new Error(message));
  }

  // -------- Retention --------

  private lastRetentionDay = -1;

  private async retentionTick(): Promise<void> {
    const now = new Date();
    if (now.getHours() !== this.deps.config.BACKUP_RETENTION_HOUR) return;
    const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    const numericDay = now.getFullYear() * 1000 + now.getMonth() * 50 + now.getDate();
    if (numericDay === this.lastRetentionDay) return;
    this.lastRetentionDay = numericDay;
    this.deps.logger.info({ day }, 'backup retention sweep starting');
    for (const inst of this.deps.listInstances()) {
      const days = inst.backupRetentionDays ?? this.deps.config.BACKUP_RETENTION_DAYS;
      const cutoff = Date.now() - days * 24 * 60 * 60_000;
      const old = this.deps.backups.listOlderThan(inst.name, 'auto', cutoff);
      for (const b of old) {
        if (!b.targetKey) continue;
        try {
          await this.deps.minio.deleteBackup(inst.bucketPrefix, b.targetKey);
          this.deps.backups.delete(b.id);
          this.deps.audit.record({
            at: Date.now(),
            actor: 'retention',
            action: 'backup_deleted_by_retention',
            instanceName: inst.name,
            details: `id=${b.id} age_days=${Math.round((Date.now() - b.startedAt) / 86_400_000)}`,
          });
        } catch (err: unknown) {
          this.deps.logger.error(
            { name: inst.name, id: b.id, err: errMsg(err) },
            'retention delete failed',
          );
        }
      }
    }
  }

  // -------- Export-blob orphan cleanup --------

  private async exportBlobCleanupTick(): Promise<void> {
    const minAge = this.deps.config.EXPORT_BLOB_CLEANUP_MIN_AGE_MS;
    const { readdir, stat } = await import('node:fs/promises');
    for (const inst of this.deps.listInstances()) {
      if (inst.status !== 'running') continue;
      const storageDir = this.deps.config.CONVEX_STORAGE_DIR_TEMPLATE.replace(
        '{instance}',
        inst.name,
      );
      const exportsDir = join(storageDir, 'exports');
      let entries: string[];
      try {
        entries = await readdir(exportsDir);
      } catch {
        // Directory doesn't exist yet (no export has run) — nothing to clean.
        continue;
      }
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.endsWith('.blob')) continue;
        const path = join(exportsDir, entry);
        try {
          const st = await stat(path);
          if (now - st.mtimeMs < minAge) continue;
          await rm(path, { force: true });
          this.deps.logger.info({ name: inst.name, path }, 'orphan export blob removed');
        } catch (err: unknown) {
          this.deps.logger.warn(
            { name: inst.name, path, err: errMsg(err) },
            'orphan export blob cleanup error',
          );
        }
      }
    }
  }

  // -------- Stuck-export detector --------

  private async stuckDetectorTick(): Promise<void> {
    const cutoff = Date.now() - this.deps.config.BACKUP_EXPORT_TIMEOUT_MINUTES * 60_000;
    const stuck = this.deps.backups.listRunningStarted(cutoff);
    for (const b of stuck) {
      // Only mark stuck if the in-process worker no longer thinks it's
      // running (the worker uses a 30 min spawn-timeout, so anything still
      // marked running past cutoff and not in inflight is genuinely stuck —
      // typically because the orchestrator restarted mid-backup).
      if (this.inflight.has(b.id)) continue;
      this.deps.backups.updateStatus(b.id, {
        status: 'stuck',
        completedAt: Date.now(),
        errorMessage: 'backup running > timeout, orchestrator does not own the job',
      });
      this.deps.audit.record({
        at: Date.now(),
        actor: 'scheduler',
        action: 'backup_stuck_detected',
        instanceName: b.instanceName,
        details: `id=${b.id} age_min=${Math.round((Date.now() - b.startedAt) / 60_000)}`,
      });
      this.deps.logger.warn(
        { id: b.id, name: b.instanceName },
        'marked backup stuck (timeout exceeded, orchestrator did not own job)',
      );
    }
  }

  private deploymentUrl(inst: Instance): string {
    return `http://${this.deps.internalHost}:${inst.cloudPort}`;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

async function rmQuiet(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    /* swallow */
  }
}
