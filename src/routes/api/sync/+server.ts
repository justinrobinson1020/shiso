import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { runAllSyncs } from '$lib/server/sync/runner';
import { syncDeps } from '$lib/server/sync/providers';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const mode = body?.mode === 'balances' ? 'balances' : 'full';
	const runs = await runAllSyncs(getDb(), 'manual', mode, syncDeps());
	return json({ runs });
};
