#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf '%s\n' 'Usage: bash scripts/build-image.sh [labturn-app:version]' \
    'Builds linux/amd64 locally. Production deployment is performed only by GitHub Actions.'
  exit 0
fi
if (( $# > 1 )); then
  printf 'Expected at most one versioned image tag.\n' >&2
  exit 2
fi
REVISION=unknown
SOURCE_STATE=snapshot
GIT_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)
if [[ "$GIT_ROOT" == "$ROOT" ]]; then
  REVISION=$(git -C "$ROOT" rev-parse HEAD)
  SOURCE_STATE=clean
  if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then SOURCE_STATE=dirty; fi
elif [[ -f "$ROOT/SOURCE_REVISION" ]]; then
  read -r REVISION < "$ROOT/SOURCE_REVISION"
fi
if [[ ! "$REVISION" =~ ^[a-f0-9]{7,40}$ ]]; then REVISION=unknown; fi
IMAGE=${1:-}
if [[ -z "$IMAGE" ]]; then
  TAG="local-$(date -u +%Y%m%dT%H%M%SZ)-${REVISION:0:12}"
  if [[ "$SOURCE_STATE" != clean ]]; then TAG="$TAG-$SOURCE_STATE"; fi
  IMAGE="labturn-app:$TAG"
fi
if [[ ! "$IMAGE" =~ ^labturn-app:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ || "$IMAGE" == labturn-app:latest ]]; then
  printf 'Use an explicit labturn-app:version tag, not latest.\n' >&2
  exit 2
fi

docker info >/dev/null
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  printf 'Image tag already exists locally; choose a new version.\n' >&2
  exit 2
fi
printf 'Building %s for linux/amd64 here (source state: %s).\n' "$IMAGE" "$SOURCE_STATE"
docker buildx build --platform linux/amd64 --load \
  --label "org.opencontainers.image.source=https://github.com/Awak3r/it_proj" \
  --label "org.opencontainers.image.revision=$REVISION" \
  --label "org.opencontainers.image.version=${IMAGE#labturn-app:}" \
  --label "ru.awak3r.labturn.source-state=$SOURCE_STATE" \
  --tag "$IMAGE" "$ROOT"
printf 'Image: %s\nProduction deployment: push the trusted branch and use GitHub Actions.\n' "$IMAGE"
