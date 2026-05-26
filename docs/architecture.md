# Architecture

The authoritative architecture document lives in [`openspec/changes/add-convex-orchestrator/design.md`](../openspec/changes/add-convex-orchestrator/design.md). This page is a short pointer plus a few diagrams for quick reference.

## Process model

```
                       host network
                            │
                ┌───────────┴───────────┐
                │      Traefik          │
                │  (file provider on    │
                │   shared docker vol)  │
                └───┬───────────┬───────┘
                    │           │
            <inst>.cvx.example  <inst>-site.cvx.example
                    │           │
        ┌───────────▼───────────▼─────────────────────────────┐
        │ orchestrator container                              │
        │ ┌───────────────┐  ┌───────────────────────────┐    │
        │ │ Hono API+UI   │  │  spawned convex-backend   │    │
        │ │ on :8080      │  │  child processes:         │    │
        │ │ + SQLite      │  │   - <inst-a> pid N        │    │
        │ │   (encrypted) │  │     :13210 (cloud)        │    │
        │ │               │  │     :13211 (site)         │    │
        │ │               │  │   - <inst-b> pid M        │    │
        │ │               │  │     :13212 / :13213       │    │
        │ │               │  │   - ...                   │    │
        │ └───────┬───────┘  └─────────────┬─────────────┘    │
        │         │ writes dynamic.yml     │ /proc samples    │
        └─────────┼────────────────────────┼──────────────────┘
                  ▼                        ▼
           shared volume           SQLite resource_samples
```

## Storage layout

- **Postgres** (shared): one DB, one schema per Convex instance (`convex_<name>`), `search_path` set per connection.
- **MinIO/S3** (shared): five buckets per instance, named `<instance>-{exports,snapshot-imports,modules,files,search}`.
- **Local SQLite**: `instances`, `port_allocations`, `resource_samples`, `audit_log`, `schema_migrations`. Admin keys and instance secrets are encrypted with a key derived from `ORCHESTRATOR_MASTER_KEY` via HKDF-SHA256.

## Routing

The orchestrator owns `${TRAEFIK_DYNAMIC_PATH}` (default `/etc/traefik/dynamic/orchestrator.yml`) and writes both per-instance routers (cloud + site) into it. Updates are atomic via temp-file + rename so Traefik (`providers.file.watch=true`) never observes a partial file.

## Process supervision

`src/server/supervisor/supervisor.ts` ties together:

- `spawn.ts` — `Bun.spawn()` of the Convex binary, with logs piped to per-instance rotating files.
- `watcher.ts` — exponential backoff (1s, 5s, 30s, 60s, 60s) with a max of 5 restarts inside a 10-minute window before giving up and marking the instance as `error`.
- `resources.ts` — every 30 s reads `/proc/<pid>/status` (`VmRSS`) and `/proc/<pid>/stat` (utime + stime), persists to SQLite, retains 24 h.
- `shutdown.ts` — SIGTERM, 10 s grace, SIGKILL.

On orchestrator restart, instances marked `running` in SQLite are re-spawned; `stopped` and `error` are left alone for operator action.
