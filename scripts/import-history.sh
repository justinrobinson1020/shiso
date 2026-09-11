#!/usr/bin/env zsh
# Backfill account history through the running app.
# usage: SHISO_URL=https://shiso.home.local scripts/import-history.sh <dir> <map-file> (--dry-run|--commit)
#        via npm the mode needs npm's own separator: npm run import:history -- <dir> <map-file> --dry-run
# The mode is required and explicit: npm eats a bare --dry-run, and a silent live run is not worth the risk.
# map-file lines: "<file-or-folder relative to dir> <accountId>"; blank lines and # comments ignored.
# Posts every file to /api/accounts/<id>/import, one report line per file, and stops at the first non-2xx.
# Order does not matter (spec §4 step 6); files are posted in sorted order. CURL_OPTS adds flags, e.g. --cacert.
set -euo pipefail
me=$0   # zsh rebinds $0 to the function name inside usage()
usage() { echo "usage: SHISO_URL=... $me <dir> <map-file> (--dry-run|--commit)  [via npm: npm run import:history -- <dir> <map-file> --dry-run]" >&2; exit 2; }
[[ $# -eq 3 ]] || usage
dir=$1; map=$2; dry=''
case $3 in
	--dry-run) dry=1 ;;
	--commit) ;;
	*) usage ;;
esac
: "${SHISO_URL:?set SHISO_URL, e.g. https://shiso.home.local}"
while read -r entry account || [[ -n ${entry:-} ]]; do
	[[ -z "$entry" || "$entry" == \#* ]] && continue
	files=()
	if [[ -d "$dir/$entry" ]]; then files=("$dir/$entry"/*(N.)); else files=("$dir/$entry"); fi
	for f in "${files[@]}"; do
		[[ "$f:t" == .* ]] && continue
		out=$(curl -sS ${=CURL_OPTS:-} -w '\n%{http_code}' -F "file=@$f" ${=dry:+-F dryRun=1} "$SHISO_URL/api/accounts/$account/import")
		code=${out##*$'\n'}; body=${out%$'\n'*}
		printf '%s\t%s\t%s\n' "$code" "$f" "$body"
		# Nonzero previousDelta means history before this statement is still missing (or doubled); nonzero
		# closingDelta means its own window does not add up. Neither is an error or a reason to stop, but
		# they are the numbers worth watching as the backfill fills in.
		for k in previousDelta closingDelta; do
			delta=$(printf '%s' "$body" | grep -oE "\"$k\":-?[0-9]+" | head -1 || true)
			delta=${delta##*:}
			if [[ -n $delta && $delta != 0 ]]; then echo "  gap: $k=$delta" >&2; fi
		done
		[[ $code == 2* ]] || { echo "stopped: $f returned $code" >&2; exit 1; }
	done
done < "$map"
