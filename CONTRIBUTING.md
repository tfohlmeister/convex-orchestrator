# Contributing

Thanks for your interest. This guide covers the dev loop, the test patterns,
and the release flow.

If you are new to the project, [README.md](./README.md) and
[docs/architecture.md](./docs/architecture.md) are a better entry point than
this file.

## Local setup

You need:

- **Bun** ≥ 1.3 (the orchestrator is a Bun process)
- **Docker** with `docker compose` (for the postgres + minio + traefik
  dependencies, and for a full end-to-end run of the supervised
  `convex-backend` children)

```sh
bun install
bun run check          # typecheck + lint + format + unit tests
```

`bun run check` does not need Docker. It exercises the orchestrator's pure
logic and the supervisor with stub children.

## Running the full stack

Use the dev compose overlay so you don't need a public domain or Let's
Encrypt credentials:

```sh
cd docker
cp .env.example .env
$EDITOR .env           # at minimum: BASE_DOMAIN, ORCHESTRATOR_MASTER_KEY
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

`docker-compose.dev.yml` exposes Traefik on `TRAEFIK_HTTP_PORT` (default
`18000`) without TLS, and tells the orchestrator to emit `http://...:18000`
origin URLs everywhere so the dashboard embed works without certs.

Point `BASE_DOMAIN` at a wildcard that resolves to your host (e.g.
`*.cvx.lan` via local DNS or `--host-resolver-rules` in Chromium).

Open `http://orchestrator.<BASE_DOMAIN>:18000` and create an instance.

## Day-to-day

```sh
bun run dev:server     # hot-reload server on :8080
bun run dev:web        # vite dev server for the UI on :5173
bun run typecheck
bun test
bun run lint
bun run format         # apply prettier formatting
```

`bun run check` runs typecheck + lint + format-check + tests, in that order.
CI runs the same set on every PR.

## Tests

Three layers, all under `bun test`:

- **Pure-logic unit tests**, `src/**/*.test.ts`. No I/O. Fast.
- **Supervisor / orchestrator integration tests** exercise the lifecycle
  state machine with stubbed `Bun.spawn`. The DI seams are
  `SupervisorDeps` and `OrchestratorDeps`.
- **Backup / restore integration tests** spin up postgres, minio, and a
  real convex-backend per test where needed; they are gated on CI to
  the `integration` job.

When you change behavior, update or add the matching test before sending
the PR. The fleet code review enforces "feature shipped without test"
as a release blocker.

## UI changes

For frontend changes don't rely on types and tests alone. Start the dev
server, drive the feature in a browser (use `playwright-cli` or
real browsing), verify the golden path and obvious edge cases, and
mention what you tested in the PR.

## Documentation

User-facing changes need a docs update:

- New top-level concept → new `docs/<concept>.md` plus a link from
  `README.md`
- Architecture-affecting change → `docs/architecture.md`
- Backup / restore / retention behaviour → `docs/backups.md`
- New env var or knob → update both the `docker/.env.example` and the
  table in `docs/backups.md` if it's a backup knob

Diagrams live as editorial-styled SVGs in `docs/diagrams/`, referenced
from the markdown via `![alt](./diagrams/foo.svg)`. The standalone
HTML wrappers (`docs/diagrams/*.html`) provide a print-friendly view
with web fonts. SVGs use system fonts so GitHub's markdown render
displays them faithfully. Don't run `prettier` on `docs/diagrams/`,
it's listed in `.prettierignore` and will reformat hand-tuned SVG
layout into a 100-line-per-attribute mess.

## OpenSpec

Larger changes (new subsystems, schema migrations, anything that touches
multiple modules) are designed in an OpenSpec change under
`openspec/changes/<date>-<slug>/` before code lands. Look at the
archived changes (`openspec/changes/archive/`) for the shape and tone.
Small fixes and surgical tweaks don't need an OpenSpec.

## Commit messages

Follow Conventional Commits where it fits, but don't agonize. The release
tooling does not parse commit messages; readability for reviewers matters
more than tag conformance.

## Pull requests

CI (`.github/workflows/ci.yml`) runs `bun install`, `bun run check`, a
multi-arch docker build, and an integration smoke test on every PR. Keep
the dist artifacts out of the diff; CI rebuilds.

The PR template prompts for summary, test plan, docs check, and breaking-
change note. Filling it out keeps the review loop short.

## Releasing

Versions are tag-driven. Pushing `v<x.y.z>` to `main` triggers
[`.github/workflows/release.yml`](./.github/workflows/release.yml), which
builds the multi-arch (`linux/amd64,linux/arm64`) image and pushes it to
`ghcr.io/tfohlmeister/convex-orchestrator:<x.y.z>` plus the `latest` tag
on stable releases.

To cut a release locally:

```sh
git tag v0.1.0
git push origin v0.1.0
```

CI then publishes the image. The README's `image:` snippet points at
`ghcr.io/tfohlmeister/convex-orchestrator:latest`, so users on the
default compose file pick up the new version on `docker compose pull`.

Pre-releases use the `-alpha`, `-beta`, or `-rc` suffix (`v0.2.0-alpha.1`)
and only update their own immutable tag, never `latest`.
