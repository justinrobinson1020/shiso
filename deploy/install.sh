#!/usr/bin/env bash
# Install or upgrade shiso on the target LXC. Run as root.
#
# Usage: install.sh <tarball>
#
# Idempotent: re-running with the same tarball (or a new one) is safe. Keeps
# the last 3 releases under /opt/shiso/releases and prunes older ones.
set -euo pipefail

if [ "$#" -ne 1 ]; then
	echo "usage: install.sh <tarball>" >&2
	exit 1
fi

tarball="$1"
if [ ! -f "$tarball" ]; then
	echo "tarball not found: $tarball" >&2
	exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
	echo "install.sh must be run as root" >&2
	exit 1
fi

sha="$(basename "$tarball" .tar.gz)"
sha="${sha#shiso-}"

echo "==> installing shiso ${sha}"

if ! id shiso >/dev/null 2>&1; then
	useradd --system --no-create-home --shell /usr/sbin/nologin shiso
fi

mkdir -p /opt/shiso/releases /opt/shiso/data /opt/shiso/backups
chown shiso:shiso /opt/shiso/data /opt/shiso/backups

release_dir="/opt/shiso/releases/${sha}"
mkdir -p "$release_dir"
tar -xzf "$tarball" -C "$release_dir"

echo "==> installing production dependencies"
(cd "$release_dir" && npm ci --omit=dev)

chown -R shiso:shiso "$release_dir"

ln -sfn "$release_dir" /opt/shiso/current

if [ ! -f /etc/systemd/system/shiso.service ]; then
	echo "==> installing systemd unit"
	cp "$release_dir/deploy/shiso.service" /etc/systemd/system/shiso.service
fi

mkdir -p /etc/shiso
if [ ! -f /etc/shiso/shiso.env ]; then
	echo "==> creating /etc/shiso/shiso.env from the example — fill it in before the service will work correctly"
	cp "$release_dir/deploy/shiso.env.example" /etc/shiso/shiso.env
	chown shiso:shiso /etc/shiso/shiso.env
	chmod 600 /etc/shiso/shiso.env
fi

echo "==> starting shiso"
systemctl daemon-reload
systemctl enable --now shiso
systemctl restart shiso

echo "==> waiting for health check"
healthy=0
body=""
for _ in $(seq 1 20); do
	if body="$(curl -sf localhost:3000/api/health)"; then
		healthy=1
		break
	fi
	sleep 1
done

if [ "$healthy" -ne 1 ]; then
	echo "shiso did not become healthy within 20 seconds" >&2
	journalctl -u shiso -n 50 --no-pager
	exit 1
fi

echo "$body"

echo "==> pruning old releases (keeping last 3)"
# shellcheck disable=SC2012
ls -1dt /opt/shiso/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf

echo "==> done"
