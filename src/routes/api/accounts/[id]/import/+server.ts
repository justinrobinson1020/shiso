import { handle, intParam, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { getSetting } from '$lib/server/settings';
import { importParsed } from '$lib/server/import/statement';
import { parseText } from '$lib/server/import/formats/detect';
import { ImportError } from '$lib/server/import/formats/types';
import { processUnprocessed } from '$lib/server/sync/postprocess';
import { todayIso } from '$lib/dates';

export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const form = await request.formData().catch(() => null);
	const file = form?.get('file');
	if (!(file instanceof File)) throw new ValidationError('file is required');
	const text = await file.text();
	const config = getConfig();
	const db = getDb();
	const today = todayIso(config.timeZone);
	let result;
	try {
		result = importParsed(db, id, parseText(text), { cadence: config.cadence, todayIso: today });
	} catch (err) {
		if (err instanceof ImportError) throw new ValidationError(err.message);
		throw err;
	}
	const processed = processUnprocessed(db, {
		todayIso: today,
		graceDays: getSetting(db, 'grace_days', 3),
		transferWindowDays: getSetting(db, 'transfer_window_days', 4)
	});
	return { created: result.created, duplicates: result.duplicates, processed: processed.processed };
});
