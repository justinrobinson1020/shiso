import { handle, readJson, cents, isoDate, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createPromo } from '$lib/server/debt/plan';
export const POST = handle(async ({ request }) => {
	const b = await readJson<Record<string, unknown>>(request);
	if (typeof b.description !== 'string' || !b.description.trim()) throw new ValidationError('description is required');
	const id = createPromo(getDb(), {
		accountId: cents(b.accountId, 'accountId'), description: b.description.trim(), originalAmount: cents(b.originalAmount, 'originalAmount'),
		remainingAmount: b.remainingAmount == null ? null : cents(b.remainingAmount, 'remainingAmount'),
		aprBps: b.aprBps == null ? 0 : cents(b.aprBps, 'aprBps'), expiresOn: isoDate(b.expiresOn, 'expiresOn')
	});
	return { id };
});
