# syntax=docker/dockerfile:1.7

# The Convex backend binary comes from the official GitHub release zip,
# verified by sha256 per architecture. It also issues admin keys, via its
# `keygen admin-key` subcommand, so the image needs no second binary for
# that. See docs/architecture.md § Design decisions worth knowing.
ARG CONVEX_VERSION=precompiled-2026-11-05-6ce65c1
ARG CONVEX_AMD64_SHA256=0755ec3b163a688d8cce2a01b292e82c5e0147518ff0eaab1b5333c27584ca15
ARG CONVEX_ARM64_SHA256=e1c677dcb2123b85058e1c5d0a12010e4324c66d3dd10ec3050e9dfda66c7be5
# dashboard.zip is platform-independent (static HTML/JS), one sha256 for all archs.
ARG CONVEX_DASHBOARD_SHA256=48073cfe4274048e43e3833c0b9019b7580963831039d28c9d715e4fb7f5400c

# ---------- Stage 1: web build ----------
FROM oven/bun:1.3 AS web-build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY tsconfig.json eslint.config.js ./
COPY src ./src
RUN bun run build:web

# ---------- Stage 2: server build ----------
FROM oven/bun:1.3 AS server-build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY tsconfig.json ./
COPY src/server ./src/server
RUN bun build src/server/index.ts --target=bun --outdir=dist/server --minify
# bun build only emits JS bundles; the migrations are loaded at runtime via
# `import.meta.url`-resolved scandir, so they need to sit next to the bundle.
RUN cp -r src/server/db/migrations dist/server/migrations

# ---------- Stage 3: fetch convex-local-backend from the release zip ----------
FROM debian:bookworm-slim AS convex-backend-bin
ARG CONVEX_VERSION
ARG CONVEX_AMD64_SHA256
ARG CONVEX_ARM64_SHA256
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/convex
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) asset="convex-local-backend-x86_64-unknown-linux-gnu.zip"; sha="$CONVEX_AMD64_SHA256" ;; \
      arm64) asset="convex-local-backend-aarch64-unknown-linux-gnu.zip"; sha="$CONVEX_ARM64_SHA256" ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/get-convex/convex-backend/releases/download/${CONVEX_VERSION}/${asset}"; \
    echo "Downloading $url"; \
    curl --fail --silent --show-error --location --output convex.zip "$url"; \
    actual=$(sha256sum convex.zip | awk '{print $1}'); \
    if [ "$actual" != "$sha" ]; then \
      echo "sha256 mismatch for $asset" >&2; \
      echo "  expected: $sha" >&2; \
      echo "  actual:   $actual" >&2; \
      exit 1; \
    fi; \
    unzip convex.zip; \
    install -D -m 0755 convex-local-backend /out/convex-local-backend
# FSL requires redistributions to include a copy of the license terms. One
# copy covers both bundled Convex artifacts (backend binary, dashboard static
# export) since they come from the same release tag.
RUN curl --fail --silent --show-error --location \
      --output /out/LICENSE.md \
      "https://raw.githubusercontent.com/get-convex/convex-backend/${CONVEX_VERSION}/LICENSE.md"

# ---------- Stage 3b: fetch dashboard static export ----------
# Convex publishes the dashboard as a pre-built static export (~3 MB zip) on
# the same release tag as the backend. We serve it ourselves via Hono with
# host-header routing on `dashboard.<base>`, so users get the official UI
# without a separate container. Credentials are handed off via the official
# postMessage embedding API from our orchestrator UI's iframe wrapper.
FROM debian:bookworm-slim AS convex-dashboard
ARG CONVEX_VERSION
ARG CONVEX_DASHBOARD_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/dash
RUN set -eux; \
    url="https://github.com/get-convex/convex-backend/releases/download/${CONVEX_VERSION}/dashboard.zip"; \
    curl --fail --silent --show-error --location --output dashboard.zip "$url"; \
    actual=$(sha256sum dashboard.zip | awk '{print $1}'); \
    if [ "$actual" != "$CONVEX_DASHBOARD_SHA256" ]; then \
      echo "sha256 mismatch for dashboard.zip" >&2; \
      echo "  expected: $CONVEX_DASHBOARD_SHA256" >&2; \
      echo "  actual:   $actual" >&2; \
      exit 1; \
    fi; \
    mkdir /out; \
    unzip -q dashboard.zip -d /out


# ---------- Stage 4: runtime ----------
FROM oven/bun:1.3-slim AS runtime
# `convex` is the official npm CLI used by the backup scheduler for
# `convex export` / `convex import` against each instance. Pinned via Renovate
# (npm:convex). Node.js + npm are required because `npx convex` shells out
# to node — Bun cannot run the CLI directly.
# Pin > 1.20 so the CLI honours CONVEX_SELF_HOSTED_URL +
# CONVEX_SELF_HOSTED_ADMIN_KEY without falling through to its interactive
# login prompt (the 1.18 build attempts to prompt and dies with
# "Cannot prompt for input in non-interactive terminals" when called for
# pre-restore backups). 1.45.0 is the version we've manually verified
# against a real instance end-to-end.
ARG CONVEX_CLI_VERSION=1.45.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini libpq5 nodejs npm \
    && npm install -g --no-fund --no-audit "convex@${CONVEX_CLI_VERSION}" \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    # `convex export` runs ensureHasConvexDependency which insists on a
    # package.json that lists `convex` as a dep — even in self-hosted
    # --url/--admin-key mode. Stub one out and spawn from this cwd.
    && mkdir -p /convex-cli-cwd \
    && printf '{"name":"orchestrator-convex-cli","private":true,"version":"0.0.0","dependencies":{"convex":"%s"}}\n' "${CONVEX_CLI_VERSION}" > /convex-cli-cwd/package.json

WORKDIR /app
# Non-root user provided by oven/bun base image (uid 1000). Copies use it
# directly so the bun process can read and execute the convex local backend
# without sudo.
COPY --from=convex-backend-bin --chown=bun:bun /out/convex-local-backend /convex/convex-local-backend
# License terms for the FSL-licensed Convex components bundled in this image
# (backend binary, dashboard static export). See NOTICE in the repo root.
COPY --from=convex-backend-bin --chown=bun:bun /out/LICENSE.md /convex/LICENSE.md
COPY --from=server-build --chown=bun:bun /app/dist/server ./dist/server
COPY --from=web-build --chown=bun:bun /app/dist/web ./dist/web
COPY --from=convex-dashboard --chown=bun:bun /out ./dist/dashboard

# Writable runtime dirs owned by bun so the process can write SQLite,
# rotating logs, and the backup work tree without elevation. The shared
# Traefik dynamic-config dir (/etc/traefik/dynamic) is mounted from the
# host with whatever ownership the host has and gets chowned at startup
# only if writable; we don't pre-create it here.
RUN mkdir -p /var/log/convex /var/lib/orchestrator /var/lib/orchestrator/backup-work \
    && chown -R bun:bun /var/log/convex /var/lib/orchestrator /convex /convex-cli-cwd

USER bun

ENV HTTP_PORT=8080 \
    DATA_DIR=/var/lib/orchestrator \
    LOG_DIR=/var/log/convex \
    CONVEX_BINARY=/convex/convex-local-backend \
    CONVEX_CLI=convex \
    BACKUP_WORK_DIR=/var/lib/orchestrator/backup-work \
    CONVEX_CLI_CWD=/convex-cli-cwd

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD curl --fail --silent http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "dist/server/index.js"]
