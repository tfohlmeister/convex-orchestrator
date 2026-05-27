# Architecture

This page is the engineering reference for the four diagrams that appear in the README, plus the
storage layout and the runtime invariants that don't fit on a diagram.

## System overview

![Architecture overview](./diagrams/architecture.svg)

One Hono process inside one container does five things:

- **Serves the React UI** at `orchestrator.<base>` and proxies the bundled Convex dashboard at
  `dashboard.<base>`. Both come off the same `:8080`, distinguished by host header.
- **Owns the SQLite state**: instances, port allocations, resource samples, backups, restore jobs,
  audit log. Admin keys and instance secrets are encrypted with a key derived from
  `ORCHESTRATOR_MASTER_KEY` via HKDF-SHA256 (see `src/server/crypto.ts`).
- **Supervises one `convex-backend` child process per instance** via `src/server/supervisor/`,
  with restart backoff, resource sampling, and graceful shutdown.
- **Writes the Traefik file-provider config** (`dynamic.yml`) atomically (temp + rename) so
  `providers.file.watch=true` never sees a partial file. Per-instance cloud and site routers are
  added or removed in place — no Traefik restart.
- **Talks to Postgres and MinIO** for shared storage. Each backend's `convex-backend` is launched
  with `-d postgres-v5-multitenant` and S3 env vars pointing at MinIO with a per-instance
  bucket prefix.

Standalone editorial-styled version of this diagram lives at
[`diagrams/architecture.html`](./diagrams/architecture.html).

## Instance lifecycle

![Instance lifecycle](./diagrams/instance-lifecycle.svg)

The `instances` SQLite row has a `status` column that takes one of four values: `creating`,
`running`, `stopped`, or `error`. The supervisor (`src/server/supervisor/supervisor.ts`) drives
the lifecycle and emits `onStatusChange` callbacks that write the column.

Restart policy (`src/server/supervisor/watcher.ts`):

- `RESTART_DELAYS_MS = [1000, 5000, 30_000, 60_000]` — backoff between attempts inside a window.
- `MAX_RESTARTS = 5` and `WINDOW_MS = 10 * 60_000` — at most five restarts in any ten-minute
  window before giving up.
- After give-up, the row flips to `error` with the last exit code/message in `last_error`.

Operator-initiated `stop` during the respawn backoff cancels the pending `setTimeout` so the
backend stays down. Without that cancel, the operator's stop would race the scheduled spawn — the
backend would come back up after stop returned successfully, while Traefik already removed the
route. The supervisor keeps a `pendingRespawn: Map<name, NodeJS.Timeout>` for this reason; see
`Supervisor` in `src/server/supervisor/supervisor.ts`.

On orchestrator restart, instances marked `running` are re-spawned by `restoreRunning()`;
`stopped` and `error` are left alone for operator action.

## Backup pipeline

![Backup flow](./diagrams/backup-flow.svg)

The backup manager (`src/server/backups/manager.ts`) runs four background ticks:

- **Scheduler** — every minute. Walks instances with `backup_enabled=1`, parses each row's
  per-instance cron (falls back to `BACKUP_DEFAULT_CRON`), enqueues a job when the cron's next
  fire is in the past.
- **Stuck detector** — every minute. Any backup row in `running` for longer than
  `BACKUP_EXPORT_TIMEOUT_MINUTES` (default 30) is flipped to `stuck` and an audit row is
  recorded. The UI surfaces a force-restart-backend button on the instance detail page.
- **Retention sweeper** — daily at `BACKUP_RETENTION_HOUR` (default 04:00 server-local). Deletes
  `source=auto` rows older than the per-instance `backup_retention_days` (falls back to
  `BACKUP_RETENTION_DAYS`). `manual`, `manual-upload`, and `pre-restore` rows are kept until the
  operator deletes them.
- **Export-blob orphan cleanup** — hourly. Walks the local `BACKUP_WORK_DIR` and removes
  `restore_*.zip` and `*.blob` files older than `EXPORT_BLOB_CLEANUP_MIN_AGE_MS`.

The export-and-upload path itself is sequential per instance and bounded by
`BACKUP_MAX_CONCURRENT` (default 2) across the fleet — Convex's export is backend-CPU-heavy and
parallelism past 2 starves request traffic. The upload uses `@aws-sdk/lib-storage`'s `Upload`
helper so single-PUT 5 GiB cap doesn't apply.

## Restore pipeline

![Restore flow](./diagrams/restore-flow.svg)

Every restore is destructive — `convex import --replace-all` drops and reloads every table — so
the manager forces a pre-restore backup first. If the pre-restore step fails, the restore aborts
with the original data intact (and the operator sees the failure on the restore job poll).

The stop + start dance between pre-restore and the import is load-bearing: the Convex
`ExportInProgress` lock is only released by a fresh backend process. Running the import without
the restart can deadlock on a stale lock from a previous (now-killed) export.

Restore jobs live in the `restore_jobs` SQLite table. The state transitions visible in the UI:
`queued → pre-backup → stopping → starting → importing → complete | failed`. On orchestrator
restart, any job not in `{complete, failed}` is flipped to `failed` with a marker so the operator
can locate the corresponding `pre-restore` backup (always recorded in the row) and decide whether
to retry or roll forward.

## Storage layout

- **Postgres** (shared): one cluster, one shared multitenant database (`POSTGRES_SHARED_DB`,
  default `convex_tenants`). Backends run with `-d postgres-v5-multitenant` and pass their
  instance name + secret; rows carry an `instance_name` discriminator column inside the shared
  tables. Per-tenant purge on delete is a Phase 2 problem; for now tenant rows linger after
  `DELETE` (see `Orchestrator.delete` in `src/server/orchestrator.ts`).
- **MinIO / S3** (shared): five buckets per instance, named
  `<instance>-{exports,snapshot-imports,modules,files,search}`, plus one
  `<instance>-backups` bucket the orchestrator uses for its own backup zips.
- **Local SQLite**: `instances`, `port_allocations`, `resource_samples`, `storage_samples`,
  `backups`, `restore_jobs`, `audit_log`, `schema_migrations`. Admin keys and instance secrets
  are encrypted at rest (AES-256-GCM, key derived from `ORCHESTRATOR_MASTER_KEY` via HKDF-SHA256).

## Routing

The orchestrator owns `${TRAEFIK_DYNAMIC_PATH}` (default
`/etc/traefik/dynamic/orchestrator.yml`) and writes both per-instance routers (cloud + site) into
it. A sibling `self.yml` carries the routers for `orchestrator.<base>` and `dashboard.<base>`,
both pointing at the orchestrator's own `:8080`. Updates are atomic (temp + rename), so Traefik's
file watcher never observes a partial file. The YAML rendering and atomic write are shared
between the per-instance writer and the self-routes writer (`src/server/traefik/writer.ts`).

`EXTERNAL_SCHEME` and `EXTERNAL_PORT_SUFFIX` flow through a single `cloudUrl`/`siteUrl` helper
(`src/server/urls.ts`) so URLs are consistent across the list endpoint, detail endpoint, the
deployment switcher payload, and the dashboard postMessage handshake.

## Design decisions worth knowing

A few load-bearing findings from the original Phase 0 spike, kept here because the code shape only
makes sense in their context:

**`-d postgres-v5-multitenant` is required for shared Postgres.** Convex's documented
`postgres-v5` mode hardcodes the database name to `carnitas` and rejects URLs that already
contain one. That means two single-tenant Convex backends cannot share a Postgres cluster — the
whole "many tenants on one Postgres" value proposition would be impossible. `postgres-v5-multitenant`
is listed in the CLI help but not in Convex's public docs; it accepts a URL with a real database
name, requires `--instance-name` + `--instance-secret` as CLI flags (env vars are not enough in
this mode), and stores rows in shared system tables (`documents`, `indexes`, `leases`,
`persistence_globals`, `read_only`) with an `instance_name` discriminator column. The orchestrator
hard-codes this mode in `src/server/supervisor/spawn.ts`. Per-tenant purge on delete is a Phase 2
problem; for now `DELETE` leaves tenant rows behind in the shared tables (see
`Orchestrator.delete` in `src/server/orchestrator.ts`).

**The Convex backend is configured by env vars, not CLI flags, for almost everything.**
`run_backend.sh` in the official image is the real contract: `POSTGRES_URL` (positional `DB_SPEC`
inside the script), `CONVEX_CLOUD_ORIGIN` / `CONVEX_SITE_ORIGIN` (not `*_URL`),
`S3_STORAGE_{EXPORTS,SNAPSHOT_IMPORTS,MODULES,FILES,SEARCH}_BUCKET` (five env vars, full bucket
names, no flag prefix), `AWS_*` for S3 creds, `INSTANCE_NAME` / `INSTANCE_SECRET` for the multi-
tenant identity, `DO_NOT_REQUIRE_SSL` for plain Postgres, `DISABLE_BEACON` for telemetry. Only
`-p`, `--site-proxy-port`, `-i`, `-d`, and `--s3-storage` are CLI flags. See the comment block in
`src/server/supervisor/spawn.ts` for the canonical invocation.

**`generate_key` is built from source, not pulled from a release.** The release zip contains only
`convex-local-backend`. The `generate_key` source (FSL-1.1-Apache-2.0, local build explicitly
permitted) is a 60-line clap wrapper around `KeyBroker::issue_admin_key`. The Dockerfile builds
it from the same git tag pinned by `CONVEX_VERSION` so the binary cannot drift from the backend.
A key generated this way is accepted by the running backend with HTTP 200 — verified end-to-end
against the NAS deployment on 2026-05-26.

**The dashboard switcher is replaced by orchestrator-driven postMessage credentials.** Convex's
official dashboard image expects `NEXT_PUBLIC_DEFAULT_LIST_DEPLOYMENTS_API_PORT` and fetches
`http://127.0.0.1:<port>/` for the deployment list — but the `127.0.0.1` resolves on the user's
browser, not the dashboard container, so the switcher cannot work for remote access. We ship the
dashboard static export ourselves (downloaded from the same Convex release tag, sha256-pinned,
extracted into `dist/dashboard/`) and serve it via host-header routing from the orchestrator's
own Hono process. The orchestrator UI embeds the dashboard in an `<iframe>` and replies to the
documented `dashboard-credentials-request` postMessage with the right `adminKey + deploymentUrl`,
pinned to the explicit dashboard origin so the credentials are not delivered to a different
origin if the iframe ever redirects (see `src/web/src/pages/DashboardEmbed.tsx`).

## See also

- [`backups.md`](./backups.md) — operator guide for the backup/restore subsystem
- [`../openspec/changes/`](../openspec/changes/) — design proposals (active + archived)
