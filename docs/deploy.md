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
apt-get install -y nodejs build-essential python3 poppler-utils
```

`build-essential` and `python3` are there for `better-sqlite3`: when no
prebuilt binary matches the container's Node ABI, `npm ci` compiles the
module with node-gyp, which needs `make`, a C++ toolchain, and Python.
Without them the first `install.sh` run fails inside `npm ci`.
`poppler-utils` provides `pdftotext`, which the Accounts page uses to read
PDF statements; without it PDF imports fail with a 500 and CSV imports still work.

`deploy/shiso.service` sets `BODY_SIZE_LIMIT=25M`. adapter-node's default body
limit is 512 KB, which rejects most statement PDFs before the app ever sees
them (they run to several MB). The import route caps uploads at 20 MB on its
own, so the process limit has to stay above that: the route should be what
rejects an oversized file, with a 400 and a message, not the server with a 413.

### History backfill

After the app is running, import account history with:

```bash
SHISO_URL=https://shiso.home.local npm run import:history -- /path/to/statements map.txt --dry-run
SHISO_URL=https://shiso.home.local npm run import:history -- /path/to/statements map.txt --commit
```

The mode argument is required, and through `npm run` it needs npm's own `--`
separator first — npm swallows a bare `--dry-run` and never passes it on, which
would silently turn a rehearsal into a live run. Calling
`scripts/import-history.sh <dir> <map.txt> --dry-run` directly needs no separator.
The script sends an `Origin` header matching `SHISO_URL` (SvelteKit's CSRF check
rejects form posts without one) and passes `CURL_OPTS` through to curl, so
`CURL_OPTS=-k` covers the homelab's self-signed certificate. To post to the container
directly (`SHISO_URL=http://<CT-IP>:3000`), set `SHISO_ORIGIN` to the app's configured
`ORIGIN` so the header still matches.

The map file is a newline-delimited list of `<file-or-folder relative to the statement directory> <accountId>` entries; blank lines and lines starting with `#` are ignored. Any further
columns on a line are extra last-four digits to accept for that account — a
reissued card keeps the account but prints a new number, and the import
rejects a statement whose printed number matches neither the account's mask nor
one of these (`chase-sapphire 1 0140`). A folder entry imports all files in it in directory order. Synchrony accounts must first be created manually on the Accounts page as a manual connection before importing their statements.

Each file prints one tab-separated `status  path  report` line, and a statement
whose report carries a nonzero `previousDelta` or `closingDelta` also prints a
`gap:` line on stderr for each. `previousDelta` is the ledger before the
statement's opening date measured against the balance the statement claims:
normal while earlier months are still missing, and 0 once the account's history
is complete. `closingDelta` is the same measurement through the statement's
closing date against its new balance. The two move together — what matters is
the difference between them, which is what the statement's own window got wrong
(a row matched against a synced transaction it is not, or one that should have
matched and did not). A file whose two deltas differ is worth looking at before
the next run; a pair that agrees is just history still missing.

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

Pi-hole (v5 on CT 101) only reads `custom.list` when FTL reloads its host
lists, so after editing it run `pihole restartdns reload-lists` from a login
shell, or `kill -HUP $(pidof pihole-FTL)`. Verify with
`dig +short shiso.home.local @10.10.50.101` → `10.10.50.130`.

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
