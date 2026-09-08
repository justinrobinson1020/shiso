import { handle, intParam } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { clearReview } from '$lib/server/ledger/transactions';

export const POST = handle(async ({ params }) => {
	clearReview(getDb(), intParam(params.id, 'id'));
	return { ok: true };
});
