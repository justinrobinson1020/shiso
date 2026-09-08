import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { claimSetupToken } from '$lib/server/sync/providers/simplefin';
import { createConnection } from '$lib/server/sync/connections';
import { runSync } from '$lib/server/sync/runner';
import { syncDeps } from '$lib/server/sync/providers';

export const POST: RequestHandler = async ({ request }) => {
	const config = getConfig();
	const body = await request.json().catch(() => null);
	if (!body?.setupToken || !body?.institutionName) return json({ error: 'setupToken and institutionName are required' }, { status: 400 });
	const accessUrl = await claimSetupToken(body.setupToken);
	const connectionId = createConnection(getDb(), { provider: 'simplefin', institutionName: body.institutionName, credential: accessUrl, appKey: config.appKey });
	const run = await runSync(getDb(), connectionId, 'manual', 'full', syncDeps());
	return json({ connectionId, run });
};
