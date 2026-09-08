import { eq } from 'drizzle-orm';
import { handle, readJson, intParam, cents, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { billOccurrences } from '$lib/server/db/schema';
import { markOccurrencePaid, unmarkOccurrence, skipOccurrence } from '$lib/server/bills/matching';

export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const b = await readJson<{ action?: string; transactionId?: unknown; amount?: unknown }>(request);
	const db = getDb();
	const opts = {
		transactionId: b.transactionId == null ? null : cents(b.transactionId, 'transactionId'),
		amount: b.amount == null ? null : cents(b.amount, 'amount')
	};
	if (b.action === 'paid') markOccurrencePaid(db, id, opts);
	else if (b.action === 'unmark') {
		if (!db.select({ id: billOccurrences.id }).from(billOccurrences).where(eq(billOccurrences.id, id)).get()) throw new Error(`occurrence ${id} not found`);
		unmarkOccurrence(db, id);
	} else if (b.action === 'skip') {
		if (!db.select({ id: billOccurrences.id }).from(billOccurrences).where(eq(billOccurrences.id, id)).get()) throw new Error(`occurrence ${id} not found`);
		skipOccurrence(db, id);
	} else throw new ValidationError('action must be paid, unmark, or skip');
	return { ok: true };
});
