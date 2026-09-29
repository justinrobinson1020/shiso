import { handle, intParam, readOptionalJson } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { runSync } from '$lib/server/sync/runner';
import { syncDeps } from '$lib/server/sync/providers';

export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.connectionId, 'connectionId');
	const body = await readOptionalJson(request);
	return runSync(getDb(), id, 'manual', body.mode === 'balances' ? 'balances' : 'full', syncDeps());
});
