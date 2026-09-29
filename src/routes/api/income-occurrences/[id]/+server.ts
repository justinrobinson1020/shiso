import { eq } from 'drizzle-orm';
import { handle, readJson, intParam, cents, ValidationError, int } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { incomeOccurrences } from '$lib/server/db/schema';
import { markIncomeReceived, unmarkIncome, skipIncome } from '$lib/server/bills/matching';
import { NotFoundError } from '$lib/server/ledger/errors';

export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const b = await readJson<{ action?: string; transactionId?: unknown; amount?: unknown }>(request);
	const db = getDb();
	const opts = {
		transactionId: b.transactionId == null ? null : int(b.transactionId, 'transactionId'),
		amount: b.amount == null ? null : cents(b.amount, 'amount')
	};
	if (b.action === 'received') markIncomeReceived(db, id, opts);
	else if (b.action === 'unmark') {
		if (!db.select({ id: incomeOccurrences.id }).from(incomeOccurrences).where(eq(incomeOccurrences.id, id)).get()) throw new NotFoundError(`income occurrence ${id} not found`);
		unmarkIncome(db, id);
	} else if (b.action === 'skip') {
		if (!db.select({ id: incomeOccurrences.id }).from(incomeOccurrences).where(eq(incomeOccurrences.id, id)).get()) throw new NotFoundError(`income occurrence ${id} not found`);
		skipIncome(db, id);
	} else throw new ValidationError('action must be received, unmark, or skip');
	return { ok: true };
});
