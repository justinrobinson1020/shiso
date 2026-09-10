# Deploying shiso

shiso runs as a systemd service on a dedicated Debian LXC, fronted by Caddy
on a separate container. This is the runbook for first install, upgrades,
and recovery.

## 1. Create the LXC

On the Proxmox host, create a new container:

- Template: Debian 12
- Network: services VLAN, `10.10.50.x`
- Resources: 1 vCPU, 1 GB RAM, 8 GB disk
- Unprivileged container
- Include it in the existing PBS backup job

## 2. Install Node 24

On the new container, install Node 24 via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs build-essential python3
```

`build-essential` and `python3` are there for `better-sqlite3`: when no
prebuilt binary matches the container's Node ABI, `npm ci` compiles the
module with node-gyp, which needs `make`, a C++ toolchain, and Python.
Without them the first `install.sh` run fails inside `npm ci`.

## 3. First release

On the Mac, in the shiso repo:

```bash
npm run release
```

This produces `dist/shiso-<sha>.tar.gz` and a `dist/shiso-<sha>.tar.gz.sha256`
checksum sidecar. Copy both to the container along with `deploy/install.sh`
(all three are needed to bootstrap — `install.sh` also ships inside the
tarball's `deploy/` directory, so any later upgrade only needs the tarball
and its checksum file):

```bash
scp dist/shiso-<sha>.tar.gz dist/shiso-<sha>.tar.gz.sha256 deploy/install.sh root@<CT-IP>:/root/
```

On the container, as root:

```bash
bash install.sh shiso-<sha>.tar.gz
```

`install.sh` refuses to run if the `.sha256` sidecar is missing or doesn't
match the tarball — this catches a corrupted transfer or a tampered file
before anything is extracted or executed. It then creates the `shiso`
system user, `/opt/shiso/{releases,data,backups}`, unpacks the release,
runs `npm ci --omit=dev` as the unprivileged `shiso` user (never as root —
`npm ci` executes arbitrary lifecycle scripts from third-party packages),
points `/opt/shiso/current` at the new release, syncs the systemd unit
(always, so hardening changes to `deploy/shiso.service` aren't silently
stuck at whatever was installed first) and the env file (only if missing,
since it holds secrets), and starts the service.

## 4. Configure and restart

Fill in `/etc/shiso/shiso.env` on the container: Plaid production
`PLAID_CLIENT_ID` / `PLAID_SECRET`, `SHISO_APP_KEY` (generate with
`openssl rand -base64 48`), and `SHISO_TZ` if it differs from
`America/New_York`. Then:

```bash
systemctl restart shiso
```

## 5. Wire up Caddy and DNS

Add `deploy/Caddyfile.snippet` to CT 130's Caddyfile, substituting the new
container's address for `<CT-IP>`, then reload Caddy.

The unit sets `Environment=HOST=0.0.0.0`, not `127.0.0.1` — Caddy runs on a
different container (CT 130, `10.10.50.130`) from shiso, so the app must
listen on all interfaces to be reachable over the network. The services
VLAN (`10.10.50.x`) is the trust boundary here, not the loopback interface;
nothing on that VLAN should be untrusted.

On CT 101 (Pi-hole), add to `custom.list`. The record points at **Caddy**
(CT 130), not at the shiso container: every `*.home.local` name on this
network resolves to the reverse proxy, which terminates TLS and forwards to
the container by the address in the vhost.

```
10.10.50.130 shiso.home.local
```

## 6. Verify

```bash
curl -s http://shiso.home.local/api/health
journalctl -u shiso -f
```

The health endpoint returns 200 JSON when healthy, 503 otherwise. Watch the
journal for the scheduler's startup line to confirm the nightly sync,
balance refresh, and backup jobs registered.

## 7. Upgrade

Rerun step 3: build a new release on the Mac, scp the tarball to the
container, run `install.sh <tarball>`. It is idempotent — it unpacks the
new release alongside the old ones, swaps the `/opt/shiso/current` symlink,
restarts the service, waits for the health check, and prunes releases
older than the last 3. The systemd unit and `/etc/shiso/shiso.env` are left
alone on upgrades (they're only created when missing).

## 8. Restore from backup

To restore from a nightly DB backup:

```bash
systemctl stop shiso
cp /opt/shiso/backups/shiso-YYYY-MM-DD.db /opt/shiso/data/shiso.db
systemctl start shiso
```

To restore the whole container, use the PBS backup job instead: restore the
CT from Proxmox Backup Server, then start the `shiso` service if it isn't
already enabled.

## 9. Remote access

There is no application-level auth (see spec §3.1) — shiso is reachable
only from the home network or over Tailscale. Off the LAN, connect through
the Tailscale exit node (CT 123) and browse to `shiso.home.local`.

## Secrets

Secrets (`SHISO_APP_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`) live only in
`/etc/shiso/shiso.env` on the target container, mode 600, owned by `shiso`.
The release tarball built by `scripts/release.sh` never contains them —
only `deploy/shiso.env.example` (blank secrets) ships inside it.
