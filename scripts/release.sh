#!/usr/bin/env bash
# Build a release tarball for shiso. Run on the Mac (or wherever the repo is
# checked out); the tarball is unpacked and built for runtime on the target
# LXC by deploy/install.sh.
#
# Usage: bash scripts/release.sh [--allow-dirty]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

allow_dirty=0
for arg in "$@"; do
	case "$arg" in
		--allow-dirty) allow_dirty=1 ;;
		*)
			echo "unknown argument: $arg" >&2
			exit 1
			;;
	esac
done

if [ "$allow_dirty" -eq 0 ] && [ -n "$(git status --porcelain)" ]; then
	echo "working tree is dirty; commit or stash changes, or pass --allow-dirty" >&2
	exit 1
fi

sha="$(git rev-parse --short HEAD)"

npm ci
npm test
npm run check
npm run build

mkdir -p dist
tarball="dist/shiso-${sha}.tar.gz"
tar -czf "$tarball" build drizzle package.json package-lock.json deploy

# install.sh verifies this checksum before extracting the tarball — scp it
# alongside the tarball.
shasum -a 256 "$tarball" | awk '{print $1}' > "${tarball}.sha256"

echo "$tarball"
