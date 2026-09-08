import { handle, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { plaidClient, syncDeps } from '$lib/server/sync/providers';
import { createLinkToken } from '$lib/server/sync/providers/plaid';
import { getConnection, getCredential } from '$lib/server/sync/connections';

export const POST = handle(async ({ request }) => {
	const config = getConfig();
	const client = syncDeps().providers.plaid ? plaidClient(config) : null;
	if (!client) throw new ValidationError('plaid not configured');
	const body = await request.json().catch(() => ({}));
	// A connectionId requests an update-mode token for relinking that item.
	let accessToken: string | null = null;
	if (body?.connectionId) {
		const connectionId = Number(body.connectionId);
		getConnection(getDb(), connectionId);
		accessToken = getCredential(getDb(), connectionId, config.appKey);
	}
	const linkToken = await createLinkToken(client, { clientName: config.plaidClientName, userId: 'shiso-owner', accessToken });
	return { linkToken };
});
