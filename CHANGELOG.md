# Changelog

## Unreleased

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
- **Borg-offsite source dirs include orchestrator + postgres volumes**
  (added in the Ansible playbook on 2026-05-28), MinIO excluded since
  its backup zips are retention-bounded and re-creatable.

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
- **Drop the leftover internal-project placeholder** in the create
  dialog (`masterev-dev`). Now `lucky-otter-123`.

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
  writes `dynamic.yml` atomically (temp + rename) so
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
  endpoint is dedicated (`/api/instances/:name/samples?metric=…`) to
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
