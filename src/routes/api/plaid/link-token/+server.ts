import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { plaidClient, syncDeps } from '$lib/server/sync/providers';
import { createLinkToken } from '$lib/server/sync/providers/plaid';
import { getCredential } from '$lib/server/sync/connections';

export const POST: RequestHandler = async ({ request }) => {
	const config = getConfig();
	const client = syncDeps().providers.plaid ? plaidClient(config) : null;
	if (!client) return json({ error: 'plaid not configured' }, { status: 400 });
	const body = await request.json().catch(() => ({}));
	// A connectionId requests an update-mode token for relinking that item.
	const accessToken = body?.connectionId ? getCredential(getDb(), Number(body.connectionId), config.appKey) : null;
	const linkToken = await createLinkToken(client, { clientName: config.plaidClientName, userId: 'shiso-owner', accessToken });
	return json({ linkToken });
};
