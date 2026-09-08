import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { plaidClient, syncDeps } from '$lib/server/sync/providers';
import { exchangePublicToken } from '$lib/server/sync/providers/plaid';
import { createConnection } from '$lib/server/sync/connections';
import { runSync } from '$lib/server/sync/runner';

export const POST: RequestHandler = async ({ request }) => {
	const config = getConfig();
	const client = plaidClient(config);
	if (!client) return json({ error: 'plaid not configured' }, { status: 400 });
	const body = await request.json().catch(() => null);
	if (!body?.publicToken || !body?.institutionName) return json({ error: 'publicToken and institutionName are required' }, { status: 400 });
	const { accessToken, itemId } = await exchangePublicToken(client, body.publicToken);
	const connectionId = createConnection(getDb(), { provider: 'plaid', institutionName: body.institutionName, externalItemId: itemId, credential: accessToken, appKey: config.appKey });
	const run = await runSync(getDb(), connectionId, 'manual', 'full', syncDeps());
	return json({ connectionId, run });
};
