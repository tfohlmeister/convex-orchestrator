# Changelog

## 0.2.6 (2026-07-05)

### Fixed

- **The documented tuning env vars now actually reach the container.**
  `docker compose` only uses `.env` for `${...}` interpolation inside the
  compose file; it does not forward arbitrary keys into a service's
  environment. The base compose file therefore silently ignored every
  documented knob that wasn't listed in its `environment:` block. All
  backup, restart, storage-sampler, and export-blob-cleanup tunables
  (`BACKUP_*`, `RESTART_*`, `STORAGE_*`, `EXPORT_BLOB_*`, `LOG_LEVEL`)
  are now passed through with their app defaults, so
  `BACKUP_RETENTION_DAYS=14` in `.env` does what the docs always said.
- **`TRAEFIK_CERT_RESOLVER` is settable from `.env`.** The base compose
  file hard-coded `letsencrypt`, so co-hosted deploys whose existing
  Traefik uses a different resolver name got routers pointing at a
  nonexistent resolver. The default is unchanged; an explicitly empty
  value writes `tls: {}` (serve Traefik's default certificate).

### Added

- **License compliance for the bundled Convex components.** The docker
  image now ships the upstream FSL-1.1-Apache-2.0 license text at
  `/convex/LICENSE.md`, and the repo gains `NOTICE` and
  `THIRD_PARTY_LICENSES.md`. The README's License section spells out the
  Apache-2.0 / FSL split and its practical consequence for users.

### Docs

- Corrected the co-hosted monitoring guidance (the UI port is bound to
  loopback; probe from the host or widen the bind deliberately), the
  upload-restore streaming description, the export-blob cleanup scope,
  and several stale references (`dynamic.yml` vs `orchestrator.yml`,
  supervisor backoff constants presented as env vars, sparkline endpoint
  path, Bun version floor).
- New README **Upgrading** section, including the 0.2.3 volume-chown
  note.
- Removed the unused `DASHBOARD_PASSWORD` from `.env.example`; added the
  tunables and `TRAEFIK_CERT_RESOLVER` instead.
- `CHANGELOG.md` restructured: the former "Unreleased" section is now
  attributed to the releases (0.1.1-0.2.5) that actually shipped it.

## 0.2.5 (2026-06-23)

### Added

- **Per-instance scheduled backend restart.** Self-hosted Convex never
  releases the executor's V8/heap memory at runtime, so a long-lived
  backend grows until it exhausts host memory. Each instance can now be
  restarted on its own cron to reclaim it.
  - New `restart_cron` + `restart_enabled` columns (migration 006),
    nullable; opt-in per instance (default off).
  - New `PUT /api/instances/:name/restart-config`
    (`{ cron?, enabled? }`); `restartCron` / `restartEnabled` added to
    the instance detail response.
  - New _Scheduled restart_ panel in the instance's Backups · Settings
    tab (cron field + enable toggle).
  - `RESTART_SCHEDULER_ENABLED` (default on) master switch and
    `RESTART_DEFAULT_CRON` (default `0 4 * * *`, after the backup
    default) for the fallback schedule.
  - A scheduled restart reuses the force-restart path (stop + respawn of
    just that backend); other instances are untouched.

### Fixed

- **Backend stop/restart now reaps the executor subprocess.** A
  `convex-local-backend` spawns a Node "executor" (`local.cjs`) to run
  Node actions; that child did not exit when its parent received
  SIGTERM, it was reparented to PID 1 and kept its (often multi-GB)
  heap. Every operator stop, delete, force-restart, and the new
  scheduled restart leaked it. `supervisor.stop` now captures the
  backend's descendant PIDs before SIGTERM and SIGKILLs any survivors,
  so a restart actually frees memory. Best-effort and Linux-only (walks
  `/proc`); degrades to a no-op elsewhere.
- **Invalid cron in the backup/restart config endpoints now returns 400,
  not 500.** `PUT /backup-config` and `PUT /restart-config` validated the
  cron via a bare `parseCron` whose plain `Error` fell through to the 500
  branch; both now raise a `400 INVALID_CRON` via a shared `assertValidCron`.
- **Changing an instance's cron takes effect immediately.** The scheduler's
  next-fire timestamp was not invalidated when the cron expression changed,
  so a backup/restart could fire once more on the old schedule before
  picking up the new one. The shared `CronTicker` now drops the stale
  next-fire when the expression changes.
- **Co-hosted overlay no longer leaks docker-provider labels.** The base
  file's `orchestrator` / `dashboard` router labels could collide with
  same-named routers of an existing stack on the shared host; the overlay
  now sets `traefik.enable: 'false'` (the UI is reached via the SSH
  forward in this mode anyway).

## 0.2.4 (2026-05-28)

No functional changes (documentation formatting only).

## 0.2.3 (2026-05-28)

### Security

- **Orchestrator container now runs as non-root** (`USER bun`, uid 1000).
  The `convex export` / `convex import` subprocess and the supervised
  `convex-local-backend` children inherit non-root. Removes the
  "RCE-to-root-in-container" path for any bug in the upload, restore,
  or spawn code.
  - **Upgrade note from any earlier release.** Existing
    `orchestrator-data` and `convex-logs` Docker volumes were created
    by the old root-running container and need a one-off chown so the
    bun user can write. Stop the container, then:
    ```sh
    docker run --rm --user 0 \
      -v convex-orchestrator_orchestrator-data:/data \
      -v convex-orchestrator_convex-logs:/logs \
      alpine sh -c 'chown -R 1000:1000 /data /logs'
    ```
    Then bring the container back up. Without this, the orchestrator
    fails on boot with `SQLITE_READONLY_DIRECTORY`.
- **Pino logger redact list** for adminKey, instanceSecret, the master
  key, Postgres credentials, S3 secret, MinIO root password. The code
  never logs these today (verified), but the redact rules are defence
  in depth against an accidental `logger.info({ instance })` or
  `logger.info({ config })` slip.

## 0.2.2 (2026-05-28)

### Changed

- **The published image is `linux/amd64` only.** Multi-arch
  (`linux/amd64,linux/arm64`) builds exhausted the CI runner's disk;
  arm64 was dropped until the build is restructured. Build locally via
  `docker-compose.dev.yml` on arm64 hosts.

## 0.2.1 (2026-05-28)

### Fixed

- **Pre-restore backup no longer dies at the convex CLI login prompt.**
  The container shipped Convex CLI `1.18.2`, which ignored the
  `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY` env vars
  and fell through to "Cannot prompt for input in non-interactive
  terminals" on every `convex export` invocation, blocking every
  scheduled and restore-from-upload pre-restore backup. Bumped to
  `1.36.1`, which honours the self-hosted env vars cleanly.

## 0.2.0 (2026-05-28)

### Added

- **Display name, distinct from the URL slug.** Instances now carry an
  optional `displayName` next to the immutable slug (formerly just
  `name`). The slug stays put because it backs the Convex
  `--instance-name`, the multi-tenant Postgres discriminator, MinIO
  bucket prefixes, and the public subdomain; the display name is the
  free-form human label shown in the UI and editable any time.
  - New `display_name` column (migration 005), nullable, NULL falls
    back to slug in the UI.
  - `POST /api/instances` accepts optional `displayName`.
  - New `PATCH /api/instances/:name/display-name` for inline edit.
  - The create dialog now has two fields (Name + URL slug) with the
    slug pre-generated on open and a refresh button to regenerate.
  - The detail page header renders the display name with a click-to-
    edit pencil; the slug shows below in mono with a copy button.
  - The overview list sorts by slug (server-side) but renders the
    display name on top with the slug as a secondary line when set.

## 0.1.1 (2026-05-28)

### Added

- **Random instance-name generator in the create dialog.** Click the
  refresh button next to the name field to fill in a
  `<adjective>-<animal>-<3-digit>` name. Pure client-side; combined
  space is ~810k names.

### Fixed

- **New-instance dialog now submits on Enter.** The form was a `<div>`
  before, so the Enter key did nothing. Wrapped it in a real `<form>`;
  the Create button is now `type="submit"` and the Cancel / Generate
  buttons are explicit `type="button"`.
- **Dashboard iframe handshake works under tunneled access.** The iframe
  source was hard-coded to `dashboard.<baseDomain>`, which under an SSH
  local forward resolves to the host's public IP (port 18000 not
  exposed publicly) and the iframe never loaded. Now falls back to
  `dashboard.<currentHostname>` when the browser's hostname is not part
  of baseDomain. `dashboard.localhost` resolves to 127.0.0.1 in modern
  browsers (RFC 6761) and reuses the same tunnel; the server's host
  routing already accepts any `dashboard.*` host.
- **Placeholder instance name in the create dialog** replaced with a
  neutral example (`lucky-otter-123`).

## 0.1.0 (2026-05-28), initial version

First public version of `convex-orchestrator`. Supervises N self-hosted
Convex backends on one host with shared Postgres + MinIO, routes them
via the Traefik file provider, and operates the fleet from a single
editorial web UI with the official Convex dashboard embedded per
instance.

### What's in the release

- **Supervisor.** One `convex-backend` child process per instance under
  a Bun-based supervisor with a backoff-aware restart watcher
  (`RESTART_DELAYS_MS = [1s, 5s, 30s, 60s]`, `MAX_RESTARTS = 5` in a
  10-minute window). Operator-initiated `stop` cancels any pending
  respawn so the backend doesn't race back up after the stop returns.
- **Subdomain routing via Traefik file provider.** The orchestrator
  writes its dynamic-config file atomically (temp + rename) so
  `providers.file.watch=true` never observes a partial file. Per-
  instance cloud + site routers are added and removed in place. No
  Traefik restart, no docker socket.
- **Shared Postgres in `postgres-v5-multitenant` mode.** Tenant rows
  carry an `instance_name` discriminator inside shared system tables.
  Postgres-v5 alone hardcodes the db name to `carnitas` and can't host
  multiple tenants; the multitenant mode is documented in the CLI help
  but not the Convex public docs.
- **MinIO with per-instance bucket prefix.** Five buckets per instance
  (`<instance>-{exports,snapshot-imports,modules,files,search}`) plus
  `<instance>-backups` for our own backup zips. SSE disabled
  (`AWS_S3_DISABLE_SSE=true`) because MinIO ships without a KMS in
  the default deployment.
- **One bundled Convex dashboard for the whole fleet.** Static export
  pulled from the same Convex release tag as the backend, sha256-
  pinned, served from the orchestrator's own Hono process via host-
  header routing on `dashboard.<base>`. Credentials are handed to the
  iframe via `postMessage` pinned to the explicit dashboard origin.
- **Scheduled per-instance backups.** Bun-process scheduler (no host
  cron), `convex export --include-file-storage`, hash + upload via
  `@aws-sdk/lib-storage`'s multipart `Upload`. Per-instance cron and
  retention overrides via the UI; defaults `0 3 * * *` daily, 30 day
  retention, `BACKUP_MAX_CONCURRENT=2` across the fleet. Stuck-export
  detection with a force-restart-backend escape hatch. Hourly orphan
  blob cleanup in the local work dir.
- **Restore.** Two-path UI: pick an existing backup row, or upload a
  zip (streamed straight to MinIO via multipart). Every restore takes
  a `pre-restore` backup first, then stops + respawns the backend
  (clears the stale Convex `ExportInProgress` lock), then runs
  `convex import --replace-all --include-file-storage`. If the pre-
  restore step fails the restore aborts with the original data
  intact. Restore jobs persisted to SQLite so polling survives an
  orchestrator restart.
- **Editorial web UI.** Warm-paper editorial design (Instrument Serif
  and Geist), per-instance tabs (Performance, Logs · Audit, Backups ·
  Settings), live log tail with disconnect surfacing, sticky tab bar
  that survives scroll, mobile-responsive sidebar.
- **Bring-your-own auth.** Optional `ORCHESTRATOR_ADMIN_TOKEN` bearer
  middleware with `timingSafeEqual`. Logs a boot-time warning when
  unset. `X-Forwarded-User` honored only in open mode to close the
  spoof vector when bearer is on.
- **At-rest encryption for admin keys and instance secrets.** AES-256-
  GCM in SQLite, data key derived from `ORCHESTRATOR_MASTER_KEY` via
  HKDF-SHA256.
- **Audit log.** Every mutating API call records actor, action, and
  outcome. UI exposes a per-instance audit panel with download.
- **Resource sampling.** Per-instance CPU, RSS, and per-bucket storage
  size, sampled by the orchestrator and surfaced as sparklines on the
  overview and time-series charts on the detail page. Sparkline
  endpoint is dedicated (`/api/instances/:name/sparkline`) to
  avoid an N+1 on the list view.
- **Health endpoints (unauthenticated).** `GET /health` is a simple
  liveness probe used by the Docker `HEALTHCHECK`; `GET /ready` returns
  503 until the boot sequence finishes; `GET /health/instances` is a
  fleet aggregator returning 200 / 503 with per-instance status and an
  internal reachability probe. The recommended external-monitoring
  path is end-to-end against the public `<instance>.<base>` URL per
  instance, not the aggregator, since end-to-end exercises the full
  DNS + TLS + Traefik + backend chain.
- **Co-hosted deployment mode.** A third compose overlay
  `docker-compose.cohosted.yml` runs the orchestrator alongside an
  existing host-level Traefik (file provider). Per-instance routers
  go through the shared Traefik; the orchestrator UI binds to
  loopback only and is reached via SSH local forward. New env
  `TRAEFIK_SELF_ROUTES_ENABLED` (default `true`) gates whether the
  orchestrator writes the `self.yml` exposing orchestrator/dashboard
  hosts. See `docs/deploy-cohosted.md`.

### Docs

`README.md`, `docs/architecture.md`, `docs/backups.md`, plus four
editorial-styled SVG diagrams (architecture, instance-lifecycle,
backup-flow, restore-flow) under `docs/diagrams/`. HTML wrappers for
each diagram give a print-friendly view with web fonts.

### CI / release

GitHub Actions workflows: typecheck + lint + format + unit tests +
multi-arch Docker build + integration smoke on every PR. Publishes
the multi-arch (`linux/amd64,linux/arm64`) image to
`ghcr.io/tfohlmeister/convex-orchestrator` on `v*` tag push.
