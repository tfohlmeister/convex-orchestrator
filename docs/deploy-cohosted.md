# Co-hosted deployment

Run `convex-orchestrator` on a host that already runs other web services
behind a shared Traefik. The base `docker-compose.yml` brings up its own
Traefik on `:80` + `:443`; in a co-hosted layout that would collide with
whatever is already listening. This overlay keeps the orchestrator, its
Postgres, and its MinIO, but routes everything through the host's
existing Traefik instead of a second one.

## When to use this

- The host already has Traefik configured with the **file provider**
  (`--providers.file.directory=... --providers.file.watch=true`).
- The existing Traefik is on a docker network you can attach new
  containers to.
- You're OK reaching the orchestrator UI + bundled Convex dashboard via
  an **SSH local forward** rather than a public host. Per-instance
  Convex URLs (`<instance>.<base-domain>`) remain public, so real
  Convex clients connect normally.

If any of the above doesn't apply, use the base `docker-compose.yml`
(public host, own Traefik) or the `docker-compose.dev.yml` overlay
(plain HTTP for development) instead.

## Resource footprint

For a fleet of ~3 small Convex backends:

| Resource | Idle                                                   | Backup window peak                              |
| -------- | ------------------------------------------------------ | ----------------------------------------------- |
| RAM      | ~1.5 GB (orchestrator + postgres + minio + 3 backends) | + 1-2 GB while two `convex export` runs overlap |
| CPU      | < 0.1 vCPU                                             | 1-2 vCPU short spike                            |
| Disk     | live data + ~1.5x for 14-day backup retention          | grows linearly with retention                   |

`BACKUP_RETENTION_DAYS=14` (lower than the default 30) is a good
starting point when disk on the shared host is the constraint.

## DNS

Wildcard A record pointing at the shared host:

```
*.<base-domain>   A   <host-ip>
```

The orchestrator emits per-instance routers for
`<instance>.<base-domain>` and `<instance>-site.<base-domain>` into the
shared Traefik's dynamic dir; the wildcard takes care of all three. HTTP-01
ACME works out of the box since the host's Traefik already terminates
`:80` and `:443`. No DNS-API credentials needed.

The orchestrator UI host (`orchestrator.<base-domain>`) and the
dashboard host (`dashboard.<base-domain>`) are **not** emitted in this
mode; you reach them through the SSH forward instead.

## Required env

In addition to the standard vars (`BASE_DOMAIN`, `ORCHESTRATOR_MASTER_KEY`,
`POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`):

```
PROXY_NETWORK=<name-of-existing-traefik-docker-network>
TRAEFIK_DYNAMIC_DIR_HOST=<host-path-of-existing-traefiks-dynamic-dir>
ORCHESTRATOR_UI_BIND_PORT=18000
TRAEFIK_CERT_RESOLVER=<resolver-name-from-existing-traefik>
```

`PROXY_NETWORK` is the network the existing Traefik is on. Find it with
`docker inspect <existing-traefik-container> --format '{{range $n,$c := .NetworkSettings.Networks}}{{$n}}{{end}}'`.

`TRAEFIK_DYNAMIC_DIR_HOST` is the host path the existing Traefik mounts
as `/etc/traefik/dynamic` (or wherever its `--providers.file.directory`
points). Find it with the same `docker inspect` and look at `Mounts`.

`TRAEFIK_CERT_RESOLVER` must match a resolver name the existing Traefik
already has configured (the value passed to
`--certificatesresolvers.<name>.acme.*`). The orchestrator writes
`tls.certresolver: <name>` into each per-instance router, and the
existing Traefik does the ACME dance.

`ORCHESTRATOR_UI_BIND_PORT` is the loopback port the orchestrator binds
on the host for the SSH forward.

## Bring it up

```sh
cd docker
cp .env.example .env
$EDITOR .env

docker compose -f docker-compose.yml -f docker-compose.cohosted.yml \
  pull orchestrator postgres minio

docker compose -f docker-compose.yml -f docker-compose.cohosted.yml \
  up -d orchestrator postgres minio
```

The explicit service list is the contract: this overlay does NOT remove
the base file's bundled `traefik` service (compose has no clean syntax
for that), it just expects you not to start it. Always name
`orchestrator postgres minio` on the `up` command.

## Reach the UI via SSH

The orchestrator binds its HTTP port to `127.0.0.1:<ORCHESTRATOR_UI_BIND_PORT>`
on the host. From your workstation:

```sh
ssh -L 18000:localhost:18000 <host-ssh-alias>
```

Then open `http://localhost:18000` in your browser. Both the orchestrator
UI and the embedded dashboard come off the same port; the orchestrator
distinguishes them via the host header internally.

For a persistent forward, add to `~/.ssh/config` against the host alias:

```
Host <host-ssh-alias>
    ...
    LocalForward 18000 localhost:18000
```

Then `ssh <host-ssh-alias>` (or just having a control-master connection
open) is enough to make `http://localhost:18000` work in your browser.

## Monitoring

The orchestrator UI is not publicly routed, so external monitoring
should target two layers separately:

1. **Orchestrator liveness** at `http://<host-private-ip>:18000/health`,
   where `<host-private-ip>` is whatever interface your monitoring
   service can reach (VPN, Tailscale, internal network). Use the host's
   private IP, not `127.0.0.1`, because the monitoring service is not
   on the host.
2. **Per-instance end-to-end** at `https://<instance>.<base-domain>/version`.
   This exercises DNS, TLS termination, the shared Traefik router, and
   the backend process. A green check here means a real Convex client
   can connect. Add one such check per instance you supervise.

The orchestrator's `/health/instances` aggregator (200 / 503 over all
instances) exists for local inspection and in-UI status badges, but the
end-to-end checks are the stronger signal and the recommended pattern
for external monitoring.

## Caveats

- **Single host = single point of failure.** Orchestrator + Convex
  fleet + whatever else the host runs all share fate. If that's
  unacceptable for one of the workloads, that workload belongs on a
  separate host.
- **No automatic resource quotas.** The orchestrator samples CPU + RSS
  per instance but does not enforce limits. A runaway tenant can
  starve the host. Set per-container Docker limits upstream if you
  need hard caps.
- **Backup retention vs disk.** A daily backup at retention `R` and
  per-instance live data `D` costs roughly `R * D * 1.5` per instance
  on disk. Tune `BACKUP_RETENTION_DAYS` lower than the default 30 if
  the shared host's disk is the constraint.
- **Postgres version pin.** Postgres 16 is the default in the base
  compose file. If the host's existing services use a different
  Postgres major and you're tempted to share a single instance: don't.
  `postgres-v5-multitenant` (the mode the supervised Convex backends
  run in) has specific schema expectations, and version coupling
  across unrelated workloads tends to bite later.
