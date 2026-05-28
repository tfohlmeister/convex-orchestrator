import pino from 'pino';

// Defence in depth. The codebase deliberately never logs adminKey,
// instanceSecret, the master key, or DB / S3 passwords; this list is a
// safety net for accidental `logger.info({ instance })` or
// `logger.info({ config })` calls. Pino replaces the matching paths
// with `[Redacted]` before the entry is serialised.
const REDACT_PATHS = [
  // Per-instance secrets that travel through Instance objects.
  '*.adminKey',
  '*.instanceSecret',
  // Encrypted blobs on the DB row would just look like junk in JSON but
  // are still secret material; redact for completeness.
  '*.admin_key_enc',
  '*.instance_secret_enc',
  // Config + env material. Two patterns: top-level config field on a
  // dedicated payload, and nested e.g. `{ config: { ... } }`.
  'ORCHESTRATOR_MASTER_KEY',
  'ORCHESTRATOR_ADMIN_TOKEN',
  'POSTGRES_PASSWORD',
  'POSTGRES_CLUSTER_URL',
  'POSTGRES_ADMIN_URL',
  'S3_SECRET_KEY',
  'MINIO_ROOT_PASSWORD',
  '*.ORCHESTRATOR_MASTER_KEY',
  '*.ORCHESTRATOR_ADMIN_TOKEN',
  '*.POSTGRES_PASSWORD',
  '*.POSTGRES_CLUSTER_URL',
  '*.POSTGRES_ADMIN_URL',
  '*.S3_SECRET_KEY',
  '*.MINIO_ROOT_PASSWORD',
];

export function createLogger(level: string): pino.Logger {
  return pino({
    level,
    base: { svc: 'orchestrator' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  });
}

export type Logger = pino.Logger;
