# Security policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in
`convex-orchestrator`, **please do not open a public GitHub issue**.

Instead, email the maintainers at <thorben@fohlmeister.com> with:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- The version (commit SHA or container tag) you observed it on
- Any deployment context that matters (auth mode, reverse-proxy in front,
  whether the orchestrator API is exposed to the public internet, etc.)

You will receive an acknowledgement within 72 hours. We aim to publish a
fix or mitigation within 30 days for high-severity issues; lower-severity
issues may take longer.

## Supported versions

This project is pre-1.0. Only the latest published version receives
security fixes. Once a 1.x release ships, we will support the current
major plus one prior major for security fixes.

## Threat model and known limits

The orchestrator is designed under the following assumptions, which are
worth understanding when evaluating its security posture:

- **The host is trusted.** The container has the keys to every supervised
  Convex backend. Anyone with root on the host machine can read the
  unencrypted instance secrets from `Bun.spawn`'s argv, the master key
  from the environment, and the decrypted admin keys from process
  memory. There is no defence against host compromise.
- **`ORCHESTRATOR_MASTER_KEY` is load-bearing.** Admin keys and instance
  secrets are stored AES-256-GCM-encrypted in SQLite, with the data key
  derived via HKDF-SHA256 from this env var. **Lose the master key,
  lose every backend.** Rotate by exporting all instance data first,
  generating a new key, redeploying with both old + new, and importing
  back. There is no online rekey path.
- **The API is open by default.** Without `ORCHESTRATOR_ADMIN_TOKEN`,
  every `/api/*` route is reachable unauthenticated. The orchestrator
  logs a startup warning when this is the case. Production deployments
  must either set the token (≥ 16 bytes, `timingSafeEqual` against the
  configured value) or front the orchestrator with a reverse-proxy
  auth layer (Traefik basicauth, Authelia, oauth2-proxy, Cloudflare
  Access).
- **`X-Forwarded-User` is honored only in open mode.** When the bearer
  token is set, the audit actor is always `admin` to close the
  spoofing vector. Don't run both at the same time.
- **`dashboard.<BASE_DOMAIN>` serves the official Convex dashboard
  static export.** The orchestrator hands credentials to the iframe
  over `postMessage` pinned to the explicit dashboard origin so a
  redirected iframe cannot exfiltrate the admin key. If you change the
  dashboard host, update the postMessage target origin in
  `src/web/src/pages/DashboardEmbed.tsx`.
- **Restore is destructive.** `convex import --replace-all` drops and
  reloads every table. The orchestrator always takes a `pre-restore`
  backup first and refuses to proceed if that step fails. `pre-restore`
  rows are exempt from the retention sweep so a botched restore stays
  rollback-able indefinitely.
- **MinIO server-side encryption is disabled.** Convex's default S3
  client requests SSE-KMS multipart uploads, but MinIO doesn't ship
  with a KMS in the default deployment and fails them. The orchestrator
  sets `AWS_S3_DISABLE_SSE=true` for the supervised backends. At-rest
  encryption for the MinIO volume is a separate concern (host
  filesystem encryption, `MINIO_KMS_AUTO_ENCRYPTION`, ...) and not
  the orchestrator's call.

## Known limitations vs. a hardened multi-tenant setup

- **Deleting an instance drops its Postgres database.** Each instance owns
  one database on the shared cluster, and `DELETE` removes it with
  `DROP DATABASE … WITH (FORCE)` alongside the MinIO buckets. That leaves
  nothing behind, but it also means a delete is unrecoverable from the
  cluster itself: the backups in MinIO are the only way back.
- **No per-instance resource quotas.** The supervisor samples CPU and
  RSS but does not enforce limits. A runaway tenant can starve the
  host. Use Docker's per-container limits or systemd slice limits
  upstream if you need hard caps.
- **No off-site backup sync built in.** Backup zips live in the MinIO
  volume only. The orchestrator does not ship a sidecar that mirrors
  them to a second target. Add one in your ops layer (restic, mc
  mirror, AWS S3 sync, whatever) if MinIO is a single point of failure
  for you.
- **No audit log retention.** The `audit_log` table grows unbounded.
  Add a cron that prunes it on your own retention schedule.

## Reporting third-party CVEs

The Convex backend binary is pulled from the
[`get-convex/convex-backend`](https://github.com/get-convex/convex-backend)
GitHub release pinned in `docker/Dockerfile` (sha256-verified per
architecture). Report binary-level vulnerabilities directly to the
Convex team; we'll update the pin once a fixed release ships.
