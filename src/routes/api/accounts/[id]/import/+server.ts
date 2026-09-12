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
	// Repeatable field: extra last-fours to accept for this account (a reissued card changes the printed number).
	const acceptMasks = form!.getAll('acceptMask').map(String).filter((m) => /^\d{4}$/.test(m));
	const config = getConfig(); const db = getDb(); const today = todayIso(config.timeZone);
	let parsed;
	try {
		parsed = await detectAndParse(new Uint8Array(await file.arrayBuffer()));
	} catch (err) {
		// Unknown format, or a parser's own plain Error on unparseable statement content (e.g. a Chase
		// file missing its Opening/Closing Date), is the caller's problem: 400. A 'pdf' ImportError means
		// pdftotext itself is broken on this host, which is ours: let it fall through to the 500 default.
		if (err instanceof ImportError) { if (err.code !== 'pdf') throw new ValidationError(err.message); throw err; }
		if (err instanceof Error) throw new ValidationError(err.message);
		throw err;
	}
	let report;
	try {
		report = importParsed(db, id, parsed, { cadence: config.cadence, todayIso: today, dryRun, acceptMasks });
	} catch (err) {
		// A mask mismatch or a failed reconciliation is also the caller's problem: 400. Anything else
		// (e.g. "account not found") is not import-specific and should hit handle()'s usual mapping.
		if (err instanceof ImportError) throw new ValidationError(err.message);
		throw err;
	}
	if (dryRun) return report;
	const processed = processUnprocessed(db, { todayIso: today, graceDays: getSetting(db, 'grace_days', 3), transferWindowDays: getSetting(db, 'transfer_window_days', 4) });
	return { ...report, processed: processed.processed };
});
