import { handle, readJson, intParam, cents } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { linkTransfer } from '$lib/server/ledger/transactions';

export const POST = handle(async ({ request, params }) => {
	const b = await readJson<{ peerId: unknown }>(request);
	linkTransfer(getDb(), intParam(params.id, 'id'), cents(b.peerId, 'peerId'));
	return { ok: true };
});
