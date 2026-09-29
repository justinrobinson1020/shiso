import { handle, readOptionalJson } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { runAllSyncs } from '$lib/server/sync/runner';
import { syncDeps } from '$lib/server/sync/providers';

export const POST = handle(async ({ request }) => {
	const body = await readOptionalJson(request);
	const runs = await runAllSyncs(getDb(), 'manual', body.mode === 'balances' ? 'balances' : 'full', syncDeps());
	return { runs };
});
