# convex-orchestrator

Run multiple self-hosted [Convex](https://convex.dev) backend instances on a single host with subdomain routing, a unified web UI, and one shared Convex dashboard for all of them.

> **Status: pre-MVP.** This README describes the target shape. Implementation is in progress — see [`openspec/changes/add-convex-orchestrator/`](openspec/changes/add-convex-orchestrator/) for the design, specs, and task list.

## Why

Self-hosted Convex is single-tenant by design: one backend process serves one deployment. If you run several Convex projects (dev/staging/prod, or multiple apps), you end up with duplicated `docker-compose.yml` files, separate admin keys to track, and no central overview. `convex-orchestrator` fills that gap without forking Convex or rebuilding their multi-tenant routing.

## What it does

- **Spawns Convex backend binaries as supervised child processes**, one per instance, all inside a single orchestrator container.
- **Routes** `<instance>.<base-domain>` and `<instance>-site.<base-domain>` via Traefik (file-provider, atomic writes).
- **Uses the official Convex dashboard's built-in deployment switcher** — one dashboard container manages every instance.
- **Shares Postgres** (schema-per-instance) and **MinIO/S3** (bucket-prefix-per-instance) across all instances to keep the resource footprint flat.
- **Generates admin keys deterministically** via the `generate_key` binary shipped alongside the Convex backend.
- **Web UI** for create / start / stop / delete, with per-instance CPU/RAM samples and log tailing.

## Quickstart (target)

```bash
git clone https://github.com/<user>/convex-orchestrator.git
cd convex-orchestrator/docker
cp .env.example .env
$EDITOR .env   # set BASE_DOMAIN, ORCHESTRATOR_MASTER_KEY, ORCHESTRATOR_ADMIN_TOKEN, ...
docker compose up -d
```

Open `https://orchestrator.<BASE_DOMAIN>`, paste your `ORCHESTRATOR_ADMIN_TOKEN`, and create your first instance. Click `Dashboard ↗` on any row to land in the official Convex dashboard, embedded and auto-authenticated for that instance.

### Dev / homelab variant (HTTP, no Let's Encrypt)

If you don't have a public domain with DNS-01 wildcard credentials, or your host already runs something on 80/443, layer the HTTP-only dev override on top of the default file:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

This exposes Traefik on `TRAEFIK_HTTP_PORT` (default 18000), drops the cert-resolver wiring, and tells the orchestrator to emit `http://...:18000` origin URLs everywhere. Point `BASE_DOMAIN` at any wildcard that resolves to the host (e.g. `*.cvx.lan` via your local DNS).

The Dockerfile pulls the Convex backend binary from the official `get-convex/convex-backend` GitHub release (sha256-pinned per architecture), builds `generate_key` from the same git tag (FSL-1.1-Apache-2.0 permits local builds), and bundles the dashboard static export — no separate dashboard container needed. See [`docs/spike-notes.md`](docs/spike-notes.md) for the full architecture write-up.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  orchestrator container                                      │
│  ┌─────────────────┐    ┌──────────────────────────────────┐ │
│  │ Bun + Hono API  │───►│ supervised convex-backend procs  │ │
│  │ React UI        │    │  ├─ instance-a (pid 42, 13210)   │ │
│  │ SQLite state    │    │  ├─ instance-b (pid 51, 13220)   │ │
│  └────────┬────────┘    │  └─ ...                          │ │
│           │             └──────────────────────────────────┘ │
│           │ writes dynamic.yml                               │
└───────────┼──────────────────────────────────────────────────┘
            ▼
┌──────────────┐  ┌────────────────────┐  ┌──────────┐  ┌──────┐
│   Traefik    │  │ convex-dashboard   │  │ Postgres │  │MinIO │
│ (file prov.) │  │ (deployment        │  │ (shared, │  │(shr.)│
│              │  │  switcher → API)   │  │ schemas) │  │      │
└──────────────┘  └────────────────────┘  └──────────┘  └──────┘
```

See [`openspec/changes/add-convex-orchestrator/design.md`](openspec/changes/add-convex-orchestrator/design.md) for the full design including decisions and trade-offs.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

Convex itself is licensed under the [Functional Source License (FSL)](https://github.com/get-convex/convex-backend/blob/main/LICENSE.md), which converts to Apache 2.0 two years after each release. `convex-orchestrator` does **not** redistribute the Convex binary; the Docker build downloads the official release artifact at build time and verifies it against a pinned sha256. End users build the image themselves, so this is a wrapper, not a fork or a competing service.

## Contributing

Issue and PR welcome once the project is public. For now this is a single-author build-out.
