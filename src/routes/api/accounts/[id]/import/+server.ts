import { handle, intParam, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { getSetting } from '$lib/server/settings';
import { detectAndParse } from '$lib/server/import/formats/detect';
import { ImportError } from '$lib/server/import/formats/types';
import { importParsed } from '$lib/server/import/statement';
import { processUnprocessed } from '$lib/server/sync/postprocess';
import { todayIso } from '$lib/dates';
const MAX_BYTES = 20 * 1024 * 1024;
export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const form = await request.formData().catch(() => null);
	const file = form?.get('file');
	if (!(file instanceof File)) throw new ValidationError('file is required');
	if (file.size > MAX_BYTES) throw new ValidationError('file is larger than 20 MB');
	const dryRun = form!.get('dryRun') === '1';
	const config = getConfig(); const db = getDb(); const today = todayIso(config.timeZone);
	let report;
	try {
		const parsed = await detectAndParse(new Uint8Array(await file.arrayBuffer()));
		report = importParsed(db, id, parsed, { cadence: config.cadence, todayIso: today, dryRun });
	} catch (err) {
		// Malformed input (unknown format, a mask mismatch, a failed reconciliation, or a parser's own
		// plain Error on unparseable statement content) is the caller's problem, not ours: 400. A 'pdf'
		// ImportError means pdftotext itself is broken on this host, which is our problem: 500.
		if (err instanceof ImportError) { if (err.code !== 'pdf') throw new ValidationError(err.message); throw err; }
		if (err instanceof Error) throw new ValidationError(err.message);
		throw err;
	}
	if (dryRun) return report;
	const processed = processUnprocessed(db, { todayIso: today, graceDays: getSetting(db, 'grace_days', 3), transferWindowDays: getSetting(db, 'transfer_window_days', 4) });
	return { ...report, processed: processed.processed };
});
