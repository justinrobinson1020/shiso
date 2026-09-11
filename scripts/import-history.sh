#!/usr/bin/env zsh
# Backfill account history through the running app.
# usage: SHISO_URL=https://shiso.home.local scripts/import-history.sh <dir> <map-file> [--dry-run]
# map-file lines: "<file-or-folder relative to dir> <accountId>"; blank lines and # comments ignored.
# Posts every file to /api/accounts/<id>/import, one report line per file, and stops at the first non-2xx.
# Order does not matter (spec §4 step 6); files are posted in sorted order. CURL_OPTS adds flags, e.g. --cacert.
set -euo pipefail
dir=$1; map=$2; dry=''
{ [[ ${3:-} == --dry-run ]] && dry=1; } || { [[ -n ${3:-} ]] && { echo "usage: SHISO_URL=... $0 <dir> <map-file> [--dry-run]" >&2; exit 2; }; }
: "${SHISO_URL:?set SHISO_URL, e.g. https://shiso.home.local}"
while read -r entry account; do
	[[ -z "$entry" || "$entry" == \#* ]] && continue
	files=()
	if [[ -d "$dir/$entry" ]]; then files=("$dir/$entry"/*(N.)); else files=("$dir/$entry"); fi
	for f in "${files[@]}"; do
		[[ "$f:t" == .* ]] && continue
		out=$(curl -sS ${=CURL_OPTS:-} -w '\n%{http_code}' -F "file=@$f" ${=dry:+-F dryRun=1} "$SHISO_URL/api/accounts/$account/import")
		code=${out##*$'\n'}; body=${out%$'\n'*}
		printf '%s\t%s\t%s\n' "$code" "$f" "$body"
		[[ $code == 2* ]] || { echo "stopped: $f returned $code" >&2; exit 1; }
	done
done < "$map"
