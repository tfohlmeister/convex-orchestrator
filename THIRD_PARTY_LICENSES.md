# Third-party licenses

## Convex components (Docker image only)

The published Docker image bundles the following from
[get-convex/convex-backend](https://github.com/get-convex/convex-backend),
Copyright Convex, Inc., licensed
[FSL-1.1-Apache-2.0](https://github.com/get-convex/convex-backend/blob/main/LICENSE.md)
(a copy ships in the image at `/convex/LICENSE.md`):

| Component               | Source                                           |
| ----------------------- | ------------------------------------------------ |
| `convex-local-backend`  | official release binary (sha256-pinned)          |
| dashboard static export | official release `dashboard.zip` (sha256-pinned) |

The `convex` npm CLI installed in the image is plain
[Apache-2.0](https://github.com/get-convex/convex-js/blob/main/LICENSE).

Practical consequence of the FSL for users of the image: using it to
offer a **commercial product or service that competes with Convex**
(e.g. selling hosted Convex backends to third parties) is not a
Permitted Purpose under Convex's license. Self-hosting backends for
your own applications, internal use, and non-commercial use are fine.
This is Convex's license on their components, not a restriction this
project adds; the orchestrator's own code stays Apache-2.0 either way.

## Bundled JavaScript packages

Minified into `dist/server` (shipped in the image) and `dist/web`
(served to browsers). Versions float within the ranges in
`package.json`; the values below are as of the time of writing.

| Package                 | License    |
| ----------------------- | ---------- |
| `@aws-sdk/client-s3`    | Apache-2.0 |
| `@aws-sdk/lib-storage`  | Apache-2.0 |
| `hono`                  | MIT        |
| `pg`                    | MIT        |
| `pino`                  | MIT        |
| `zod`                   | MIT        |
| `react`                 | MIT        |
| `react-dom`             | MIT        |
| `react-router-dom`      | MIT        |
| `recharts`              | MIT        |
| `@tanstack/react-query` | MIT        |

Full license texts are in each package's directory under
`node_modules/` in this repository's lockfile-resolved tree, and in the
packages' upstream repositories.

## Fonts

The web UI loads the Instrument Serif, Geist, and Geist Mono font
families from Google Fonts at runtime (not bundled). All are licensed
under the SIL Open Font License 1.1.
