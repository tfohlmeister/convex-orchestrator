# syntax=docker/dockerfile:1.7

# The Convex backend binary comes from the official GitHub release zip,
# verified by sha256 per architecture. The `generate_key` binary is built from
# the same git tag (FSL-1.1-Apache-2.0, building locally is permitted): a
# 60-line clap wrapper around `KeyBroker::issue_admin_key`. Build takes ~90s
# native, longer under qemu cross-compile. See docs/spike-notes.md §1.
ARG CONVEX_VERSION=precompiled-2026-05-18-c3ac00a
ARG CONVEX_AMD64_SHA256=2a551877337c80339b746589edc7f2ade22c613160b828e6afcf93294458b430
ARG CONVEX_ARM64_SHA256=9f831789ad36a5e1e0f73fb54a626e0bbf7c8aff55250b7e74ee278370c49518
# dashboard.zip is platform-independent (static HTML/JS), one sha256 for all archs.
ARG CONVEX_DASHBOARD_SHA256=cb730167425cffc69aecc7a0d1708067726734b213f5832b0d94bf22ded16380

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


# ---------- Stage 4: build generate_key from source ----------
# Use rust:1 (Debian-based) since it ships rustup, which honors the repo's
# `rust-toolchain.toml` pin (currently nightly-2026-02-18) automatically.
FROM rust:1 AS convex-genkey
ARG CONVEX_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      git protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch "${CONVEX_VERSION}" \
      https://github.com/get-convex/convex-backend.git .
RUN cargo build --release -p keybroker --bin generate_key \
    && install -m 0755 target/release/generate_key /generate_key

# ---------- Stage 5: runtime ----------
FROM oven/bun:1.3-slim AS runtime
# `convex` is the official npm CLI used by the backup scheduler for
# `convex export` / `convex import` against each instance. Pinned via Renovate
# (npm:convex). Node.js + npm are required because `npx convex` shells out
# to node — Bun cannot run the CLI directly.
ARG CONVEX_CLI_VERSION=1.18.2
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
COPY --from=convex-backend-bin /out/convex-local-backend /convex/convex-local-backend
COPY --from=convex-genkey /generate_key /convex/generate_key
COPY --from=server-build /app/dist/server ./dist/server
COPY --from=web-build /app/dist/web ./dist/web
COPY --from=convex-dashboard /out ./dist/dashboard

RUN mkdir -p /var/log/convex /var/lib/orchestrator /var/lib/orchestrator/backup-work

ENV HTTP_PORT=8080 \
    DEPLOYMENTS_API_PORT=8081 \
    DATA_DIR=/var/lib/orchestrator \
    LOG_DIR=/var/log/convex \
    CONVEX_BINARY=/convex/convex-local-backend \
    GENERATE_KEY_BINARY=/convex/generate_key \
    CONVEX_CLI=convex \
    BACKUP_WORK_DIR=/var/lib/orchestrator/backup-work \
    CONVEX_CLI_CWD=/convex-cli-cwd

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD curl --fail --silent http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "dist/server/index.js"]
