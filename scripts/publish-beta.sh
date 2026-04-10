#!/usr/bin/env bash
set -euo pipefail

# Publish a beta version to npm from a dev machine.
# Usage: ./scripts/publish-beta.sh [--dry-run]

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  echo "Dry-run mode — nothing will be published."
fi

VERSION="$(node -p "require('./package.json').version")-beta.$(git rev-parse --short HEAD)"

echo "Publishing @pruddiman/dispatch@${VERSION} to npm (tag: beta)..."

npm version "$VERSION" --no-git-tag-version
npm run build
npm publish --tag beta --no-provenance $DRY_RUN

# Reset package.json version so the working tree stays clean
git checkout -- package.json package-lock.json
