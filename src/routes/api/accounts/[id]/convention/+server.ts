import { handle, readJson, intParam, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getSetting, setSetting } from '$lib/server/settings';
import { PENDING_CONVENTION_KEY } from '$lib/server/reconcile';

export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const b = await readJson<{ convention?: string }>(request);
	if (b.convention !== 'exclude_pending' && b.convention !== 'include_pending') throw new ValidationError('convention is invalid');
	const db = getDb();
	const map = getSetting<Record<string, string>>(db, PENDING_CONVENTION_KEY, {});
	setSetting(db, PENDING_CONVENTION_KEY, { ...map, [String(id)]: b.convention });
	return { ok: true };
});
