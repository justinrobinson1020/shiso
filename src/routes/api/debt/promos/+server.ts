import { handle, readJson, cents, isoDate, ValidationError, int } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createPromo } from '$lib/server/debt/plan';
export const POST = handle(async ({ request }) => {
	const b = await readJson<Record<string, unknown>>(request);
	if (typeof b.description !== 'string' || !b.description.trim()) throw new ValidationError('description is required');
	const id = createPromo(getDb(), {
		accountId: int(b.accountId, 'accountId'), description: b.description.trim(), originalAmount: cents(b.originalAmount, 'originalAmount'),
		remainingAmount: b.remainingAmount == null ? null : cents(b.remainingAmount, 'remainingAmount'),
		aprBps: b.aprBps == null ? 0 : int(b.aprBps, 'aprBps'), expiresOn: isoDate(b.expiresOn, 'expiresOn')
	});
	return { id };
});
