import { mkdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Logger } from '../logger.ts';
import type { Config } from '../config.ts';
import type { AuditRepo, BackupRepo, InstanceRepo, Backup } from '../db/repos.ts';
import type { MinioStorage } from '../storage/minio.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { BackupManager } from './manager.ts';
import { runImport } from './cli.ts';
import { OrchestratorError } from '../api/errors.ts';

export type RestoreJobStatus =
  | 'queued'
  | 'pre-backup'
  | 'stopping'
  | 'starting'
  | 'importing'
  | 'complete'
  | 'failed';

export interface RestoreJob {
  id: string;
  instanceName: string;
  sourceBackupId: string;
  preRestoreBackupId: string | null;
  status: RestoreJobStatus;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface RestoreManagerDeps {
  config: Config;
  logger: Logger;
  instances: InstanceRepo;
  backups: BackupRepo;
  audit: AuditRepo;
  minio: MinioStorage;
  orchestrator: Orchestrator;
  backupManager: BackupManager;
  internalHost: string;
}

export class RestoreManager {
  private jobs = new Map<string, RestoreJob>();

  constructor(private readonly deps: RestoreManagerDeps) {}

  getJob(id: string): RestoreJob | null {
    return this.jobs.get(id) ?? null;
  }

  // Streams an uploaded `.zip` into MinIO, registers it as a manual-upload
  // backup row, then kicks off the normal restore flow against it.
  // Caller passes a local temp-file path (Hono's multipart already writes
  // to disk; we don't buffer in RAM).
  async startRestoreFromUpload(
    instanceName: string,
    localPath: string,
    actor: string,
  ): Promise<string> {
    const inst = this.deps.instances.get(instanceName);
    if (!inst) {
      throw new OrchestratorError(404, 'NOT_FOUND', `instance ${instanceName} not found`);
    }
    const { streamFileToBackup } = await import('./upload.ts');
    const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = randomUUID();
    const key = `upload-${isoStamp}_${id}.zip`;
    const startedAt = Date.now();
    this.deps.backups.insert({
      id,
      instanceName,
      source: 'manual-upload',
      startedAt,
      completedAt: null,
      status: 'running',
      targetKey: null,
      sizeBytes: null,
      sha256: null,
      convexVersion: process.env.CONVEX_VERSION ?? 'unknown',
      errorMessage: null,
    });
    try {
      const { sizeBytes, sha256 } = await streamFileToBackup(
        this.deps.minio,
        inst.bucketPrefix,
        key,
        localPath,
      );
      this.deps.backups.updateStatus(id, {
        status: 'complete',
        completedAt: Date.now(),
        targetKey: key,
        sizeBytes,
        sha256,
      });
      this.deps.audit.record({
        at: Date.now(),
        actor,
        action: 'backup_uploaded',
        instanceName,
        details: `id=${id} size=${sizeBytes} sha256=${sha256.slice(0, 12)}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.backups.updateStatus(id, {
        status: 'failed',
        completedAt: Date.now(),
        errorMessage: msg,
      });
      throw new OrchestratorError(500, 'UPLOAD_FAILED', `failed to upload zip: ${msg}`);
    } finally {
      await rmQuiet(localPath);
    }
    return this.startRestoreFromBackup(instanceName, id, actor);
  }

  // Async fire-and-forget. Returns the job id for polling.
  startRestoreFromBackup(instanceName: string, backupId: string, actor: string): string {
    const inst = this.deps.instances.get(instanceName);
    if (!inst) {
      throw new OrchestratorError(404, 'NOT_FOUND', `instance ${instanceName} not found`);
    }
    const source = this.deps.backups.get(backupId);
    if (!source) {
      throw new OrchestratorError(404, 'NOT_FOUND', `backup ${backupId} not found`);
    }
    if (source.instanceName !== instanceName) {
      throw new OrchestratorError(
        400,
        'WRONG_INSTANCE',
        `backup ${backupId} belongs to ${source.instanceName}, not ${instanceName}`,
      );
    }
    if (source.status !== 'complete' || !source.targetKey) {
      throw new OrchestratorError(
        400,
        'BACKUP_NOT_RESTORABLE',
        `backup ${backupId} is ${source.status} and not restorable`,
      );
    }
    const id = randomUUID();
    const job: RestoreJob = {
      id,
      instanceName,
      sourceBackupId: backupId,
      preRestoreBackupId: null,
      status: 'queued',
      error: null,
      startedAt: Date.now(),
      completedAt: null,
    };
    this.jobs.set(id, job);
    void this.runRestore(job, actor).catch((err: unknown) => {
      this.deps.logger.error(
        { id, name: instanceName, err: err instanceof Error ? err.message : String(err) },
        'restore job crashed',
      );
    });
    return id;
  }

  private async runRestore(job: RestoreJob, actor: string): Promise<void> {
    const inst = this.deps.instances.get(job.instanceName);
    if (!inst) {
      this.fail(job, `instance ${job.instanceName} disappeared`);
      return;
    }
    const source = this.deps.backups.get(job.sourceBackupId);
    if (!source?.targetKey) {
      this.fail(job, 'source backup vanished or has no target key');
      return;
    }

    this.deps.audit.record({
      at: Date.now(),
      actor,
      action: 'restore_started',
      instanceName: job.instanceName,
      details: `source_backup_id=${job.sourceBackupId} job=${job.id}`,
    });

    // 1) Pre-restore backup. Blocks until complete or fails the restore.
    job.status = 'pre-backup';
    let preBackup: Backup;
    try {
      preBackup = await this.deps.backupManager.runPreRestoreBackup(inst, actor);
    } catch (err: unknown) {
      this.fail(job, `pre-restore backup failed: ${errMsg(err)}`);
      return;
    }
    job.preRestoreBackupId = preBackup.id;

    // 2) Download the source zip to a local temp file. Convex CLI imports
    // from a local path; the orchestrator must materialize the zip first.
    const workDir = this.deps.config.BACKUP_WORK_DIR;
    await mkdir(workDir, { recursive: true });
    const localZip = join(workDir, `restore_${job.id}.zip`);
    try {
      const stream = await this.deps.minio.getBackupStream(inst.bucketPrefix, source.targetKey);
      await pipeline(stream, createWriteStream(localZip));
    } catch (err: unknown) {
      this.fail(job, `download from MinIO failed: ${errMsg(err)}`);
      return;
    }

    // 3) Stop + restart the backend fresh. This clears any in-flight export
    // locks and gives `convex import --replace-all` a clean target.
    job.status = 'stopping';
    try {
      await this.deps.orchestrator.stop(job.instanceName, actor);
      job.status = 'starting';
      await this.deps.orchestrator.start(job.instanceName, actor);
    } catch (err: unknown) {
      this.fail(job, `backend stop/start failed: ${errMsg(err)}`);
      await rmQuiet(localZip);
      return;
    }
    // Give the backend a brief moment to bind before we hit it.
    await sleep(2_000);

    // 4) Run convex import --replace-all --include-file-storage. The
    // backend is the one we just respawned; admin key is unchanged because
    // we stored the instance secret + key at create time and the same
    // backend identity comes up.
    job.status = 'importing';
    const imp = await runImport({
      deploymentUrl: `http://${this.deps.internalHost}:${inst.cloudPort}`,
      adminKey: inst.adminKey,
      inputPath: localZip,
      convexCli: this.deps.config.CONVEX_CLI,
      timeoutMs: this.deps.config.BACKUP_EXPORT_TIMEOUT_MINUTES * 60_000,
    });
    await rmQuiet(localZip);

    if (!imp.success) {
      const msg = imp.timedOut
        ? `convex import timed out`
        : `convex import failed (exit=${imp.exitCode ?? 'null'}): ${imp.stderr.slice(0, 1000)}`;
      this.fail(job, msg);
      return;
    }

    job.status = 'complete';
    job.completedAt = Date.now();
    this.deps.audit.record({
      at: job.completedAt,
      actor,
      action: 'restore_completed',
      instanceName: job.instanceName,
      details: `source_backup_id=${job.sourceBackupId} pre_restore_backup_id=${preBackup.id} job=${job.id}`,
    });
    this.deps.logger.info(
      { name: job.instanceName, job: job.id, ms: job.completedAt - job.startedAt },
      'restore complete',
    );
  }

  private fail(job: RestoreJob, message: string): void {
    job.status = 'failed';
    job.error = message;
    job.completedAt = Date.now();
    this.deps.audit.record({
      at: job.completedAt,
      actor: 'restore-manager',
      action: 'restore_failed',
      instanceName: job.instanceName,
      details: `job=${job.id} reason=${message.slice(0, 300)}`,
    });
    this.deps.logger.error({ id: job.id, name: job.instanceName, message }, 'restore failed');
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rmQuiet(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    /* swallow */
  }
}
