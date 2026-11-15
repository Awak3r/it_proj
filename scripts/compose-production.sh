#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
RELEASE_ENV=${LABTURN_RELEASE_ENV:-"$ROOT/../ops/image.env"}
if [[ ! -f "$ROOT/.env" || ! -f "$RELEASE_ENV" ]]; then
  printf 'Production requires the server .env and image.env; do not copy secrets to the PC.\n' >&2
  exit 1
fi
DOCKER=(docker)
if (( EUID != 0 )); then DOCKER=(sudo -n docker); fi
exec "${DOCKER[@]}" compose --project-name labturn --profile https \
  --env-file "$ROOT/.env" --env-file "$RELEASE_ENV" \
  -f "$ROOT/compose.yaml" -f "$ROOT/compose.production.yaml" "$@"
