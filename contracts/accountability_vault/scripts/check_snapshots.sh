#!/usr/bin/env bash
# check_snapshots.sh — regenerate ledger snapshots and diff against committed copies.
#
# Usage:
#   ./scripts/check_snapshots.sh           # check mode (fails on drift)
#   REGEN=1 ./scripts/check_snapshots.sh   # regen mode (overwrites committed files)
#
# Exit codes:
#   0  snapshots match (or regen completed successfully)
#   1  drift detected or cargo test failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SNAPSHOT_DIR="${CONTRACT_DIR}/test_snapshots"

# ── 1. Run tests to regenerate snapshots into a temp directory ─────────────────
TMPDIR_SNAPSHOTS="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_SNAPSHOTS}"' EXIT

echo "Running cargo test in ${CONTRACT_DIR} ..."
(
  cd "${CONTRACT_DIR}"
  SOROBAN_TEST_SNAPSHOT_DIR="${TMPDIR_SNAPSHOTS}" cargo test 2>&1
)

# ── 2. Regen mode: overwrite committed snapshots and exit ──────────────────────
if [[ "${REGEN:-0}" == "1" ]]; then
  echo "REGEN=1: copying fresh snapshots to ${SNAPSHOT_DIR} ..."
  cp -r "${TMPDIR_SNAPSHOTS}/." "${SNAPSHOT_DIR}/"
  echo "Done. Commit the updated snapshots."
  exit 0
fi

# ── 3. Check mode: diff fresh snapshots against committed ones ─────────────────
echo "Diffing fresh snapshots against committed snapshots ..."

DIFF_OUTPUT="$(diff -rq --exclude='*.tmp' "${SNAPSHOT_DIR}" "${TMPDIR_SNAPSHOTS}" 2>&1 || true)"

if [[ -z "${DIFF_OUTPUT}" ]]; then
  echo "OK: snapshots are stable — no drift detected."
  exit 0
fi

echo ""
echo "SNAPSHOT DRIFT DETECTED:"
echo "${DIFF_OUTPUT}"
echo ""
echo "To inspect the full diff:"
echo "  diff -r ${SNAPSHOT_DIR} ${TMPDIR_SNAPSHOTS}"
echo ""
echo "To update committed snapshots:"
echo "  REGEN=1 ./scripts/check_snapshots.sh"
echo ""
exit 1
