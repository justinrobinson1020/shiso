import { handle, readJson, str, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { plaidClient, syncDeps } from '$lib/server/sync/providers';
import { exchangePublicToken, removeItem } from '$lib/server/sync/providers/plaid';
import { createConnection } from '$lib/server/sync/connections';
import { runSync } from '$lib/server/sync/runner';

export const POST = handle(async ({ request }) => {
	const config = getConfig();
	const client = plaidClient(config);
	if (!client) throw new ValidationError('plaid not configured');
	const b = await readJson<Record<string, unknown>>(request);
	const publicToken = str(b.publicToken, 'publicToken');
	const institutionName = str(b.institutionName, 'institutionName');
	const { accessToken, itemId } = await exchangePublicToken(client, publicToken);
	let connectionId: number;
	try {
		connectionId = createConnection(getDb(), { provider: 'plaid', institutionName, externalItemId: itemId, credential: accessToken, appKey: config.appKey });
	} catch (err) {
		// The access token exists only in memory; without a row it is unrecoverable, so revoke the item rather than orphan it.
		await removeItem(client, accessToken);
		throw err;
	}
	const run = await runSync(getDb(), connectionId, 'manual', 'full', syncDeps());
	return { connectionId, run };
});
