import { handle, readJson, str } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { claimSetupToken } from '$lib/server/sync/providers/simplefin';
import { createConnection } from '$lib/server/sync/connections';
import { runSync } from '$lib/server/sync/runner';
import { syncDeps } from '$lib/server/sync/providers';

export const POST = handle(async ({ request }) => {
	const b = await readJson<Record<string, unknown>>(request);
	const setupToken = str(b.setupToken, 'setupToken');
	const institutionName = str(b.institutionName, 'institutionName');
	const accessUrl = await claimSetupToken(setupToken);
	const connectionId = createConnection(getDb(), { provider: 'simplefin', institutionName, credential: accessUrl, appKey: getConfig().appKey });
	const run = await runSync(getDb(), connectionId, 'manual', 'full', syncDeps());
	return { connectionId, run };
});
