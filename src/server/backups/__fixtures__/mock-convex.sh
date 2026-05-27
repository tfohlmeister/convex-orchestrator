#!/usr/bin/env bash
# Mock `convex` CLI for integration tests. Behavior is driven entirely by
# env vars set by the test harness:
#
#   MOCK_CONVEX_EXPORT_MODE=ok|fail|hang|wrong-instance
#   MOCK_CONVEX_IMPORT_MODE=ok|fail|wrong-instance
#   MOCK_CONVEX_EXPORT_PAYLOAD=<bytes-to-write>  (default "FAKE-CONVEX-EXPORT-ZIP\n")
#   MOCK_CONVEX_INSTANCE_NAME=<expected-instance-name-encoded-into-zip>
#
# Parses the `convex` CLI invocation enough to find --path (export) and
# the positional path (import). The orchestrator's cli.ts spawns this
# with --url + --admin-key flags too; we just ignore them.

set -euo pipefail

cmd="${1:-help}"
shift || true

case "$cmd" in
  export)
    # Find --path <p>
    path=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --path)
          path="$2"; shift 2 ;;
        --url|--admin-key|--include-file-storage|--prod)
          # consume value if next looks like a value
          if [ "$1" = "--include-file-storage" ] || [ "$1" = "--prod" ]; then
            shift
          else
            shift 2
          fi ;;
        *)
          shift ;;
      esac
    done
    if [ -z "$path" ]; then
      echo "mock-convex export: missing --path" >&2
      exit 2
    fi
    case "${MOCK_CONVEX_EXPORT_MODE:-ok}" in
      ok)
        # Write the deterministic fake zip. Embeds the expected instance
        # name so the matching `import` can verify it matches the target.
        inst="${MOCK_CONVEX_INSTANCE_NAME:-unknown}"
        printf 'FAKE-CONVEX-EXPORT instance=%s payload=%s\n' \
          "$inst" "${MOCK_CONVEX_EXPORT_PAYLOAD:-default}" > "$path"
        exit 0
        ;;
      wrong-instance)
        # Write a zip stamped with the WRONG instance name. import will
        # refuse it because the embedded name doesn't match the target.
        printf 'FAKE-CONVEX-EXPORT instance=%s payload=wrong\n' \
          "${MOCK_CONVEX_WRONG_INSTANCE:-other-instance}" > "$path"
        exit 0
        ;;
      fail)
        echo "mock-convex: simulated failure" >&2
        exit 1
        ;;
      hang)
        # Sleep "forever" so the spawn timeout (configured by the test)
        # is what eventually kills us.
        sleep 600
        ;;
      *)
        echo "mock-convex: unknown export mode ${MOCK_CONVEX_EXPORT_MODE:-}" >&2
        exit 3
        ;;
    esac
    ;;
  import)
    # The positional path is the last non-flag arg. Walk and capture it.
    in_path=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --url|--admin-key|--table|--format|--component)
          shift 2 ;;
        --replace-all|--replace|--append|-y|--yes)
          shift ;;
        *)
          in_path="$1"; shift ;;
      esac
    done
    if [ -z "$in_path" ]; then
      echo "mock-convex import: missing input path" >&2
      exit 2
    fi
    if [ ! -f "$in_path" ]; then
      echo "mock-convex import: file not found: $in_path" >&2
      exit 2
    fi
    case "${MOCK_CONVEX_IMPORT_MODE:-ok}" in
      ok)
        # Read the embedded instance name from the fake zip and verify
        # it matches MOCK_CONVEX_INSTANCE_NAME if set. Mirrors Convex's
        # real "wrong instance" rejection.
        expected="${MOCK_CONVEX_INSTANCE_NAME:-}"
        embedded=$(head -1 "$in_path" | sed -n 's/.*instance=\([^ ]*\).*/\1/p')
        if [ -n "$expected" ] && [ "$embedded" != "$expected" ]; then
          echo "mock-convex import: instance mismatch (zip has '$embedded', target is '$expected')" >&2
          exit 1
        fi
        # Pretend the import worked.
        exit 0
        ;;
      fail)
        echo "mock-convex import: simulated failure" >&2
        exit 1
        ;;
      *)
        echo "mock-convex: unknown import mode ${MOCK_CONVEX_IMPORT_MODE:-}" >&2
        exit 3
        ;;
    esac
    ;;
  *)
    echo "mock-convex: unsupported subcommand '$cmd'" >&2
    exit 4
    ;;
esac
