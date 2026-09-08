import { handle, intParam } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { deleteUserTransaction } from '$lib/server/ledger/transactions';

export const POST = handle(async ({ params }) => {
	deleteUserTransaction(getDb(), intParam(params.id, 'id'));
	return { ok: true };
});
