import { handle, readJson, cents, isoDate, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createManualTransaction } from '$lib/server/ledger/transactions';

export const POST = handle(async ({ request }) => {
	const b = await readJson<{ accountId: unknown; postedDate: unknown; amount: unknown; payee?: string; memo?: string | null; categoryId?: unknown }>(request);
	if (!b.payee?.trim()) throw new ValidationError('payee is required');
	try {
		return {
			id: createManualTransaction(getDb(), {
				accountId: cents(b.accountId, 'accountId'),
				postedDate: isoDate(b.postedDate, 'postedDate'),
				amount: cents(b.amount, 'amount'),
				payee: b.payee.trim(),
				memo: b.memo ?? null,
				categoryId: b.categoryId == null ? null : cents(b.categoryId, 'categoryId')
			})
		};
	} catch (err) {
		if (err instanceof Error && err.message.startsWith('no period covers')) throw new ValidationError(err.message);
		throw err;
	}
});
