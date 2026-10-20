import { handle, readJson, intParam, cents, isoDate } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createAdjustment, driftForAccount, driftSettled, SETTLE_FULL_SYNCS } from '$lib/server/reconcile';
import { InvariantError } from '$lib/server/ledger/errors';

export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const b = await readJson<{ amount: unknown; date: unknown }>(request);
	const amount = cents(b.amount, 'amount');
	const db = getDb();
	return db.transaction((tx) => {
		const d = driftForAccount(tx, id);
		if (d.drift == null || d.drift !== amount) throw new InvariantError('DRIFT_CHANGED', `drift is now ${d.drift ?? 'unknown'}`);
		if (!driftSettled(tx, id)) throw new InvariantError('DRIFT_UNSETTLED', `drift has not survived ${SETTLE_FULL_SYNCS} full syncs; it may be transactions the feed has not delivered yet`);
		return { id: createAdjustment(tx, id, amount, isoDate(b.date, 'date')) };
	});
});
