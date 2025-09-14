#!/usr/bin/env bash
set -euo pipefail

# Defaults
DATA_DIR="."
DEV=1

usage() {
  echo "Usage: $0 [-d <data_dir>] [--no-dev]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--data-dir)
      DATA_DIR="${2:-.}"; shift 2 ;;
    --no-dev)
      DEV=0; shift ;;
    -h|--help)
      usage ;;
    *)
      echo "Unknown arg: $1" >&2; usage ;;
  esac
done

# Activate venv if present
if [[ -f ".venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

if ! command -v python >/dev/null 2>&1; then
  echo "Python not found on PATH. Please install Python 3.10+" >&2
  exit 1
fi

ARGS=("explore/run.py" "--data-dir" "$DATA_DIR")
if [[ "$DEV" == "1" ]]; then
  ARGS+=("--dev")
fi

echo "Running: python ${ARGS[*]}" >&2
exec python "${ARGS[@]}"

