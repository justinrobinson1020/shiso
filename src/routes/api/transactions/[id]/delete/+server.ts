import { handle, intParam } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { deleteUserTransaction } from '$lib/server/ledger/transactions';
import { unwindRemovedTransactions } from '$lib/server/bills/matching';

export const POST = handle(async ({ params }) => {
	const id = intParam(params.id, 'id');
	// Same contract as a provider removal (sync runner): the row goes, and any auto bill or income
	// match it had settled reopens with it, in one transaction.
	getDb().transaction((tx) => {
		deleteUserTransaction(tx, id);
		unwindRemovedTransactions(tx, [id]);
	});
	return { ok: true };
});
