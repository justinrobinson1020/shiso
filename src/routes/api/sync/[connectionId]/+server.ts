import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/instance';
import { runSync } from '$lib/server/sync/runner';
import { syncDeps } from '$lib/server/sync/providers';

export const POST: RequestHandler = async ({ request, params }) => {
	const id = Number(params.connectionId);
	if (!Number.isInteger(id)) return json({ error: 'bad connection id' }, { status: 400 });
	const body = await request.json().catch(() => ({}));
	const mode = body?.mode === 'balances' ? 'balances' : 'full';
	try {
		return json(await runSync(getDb(), id, 'manual', mode, syncDeps()));
	} catch (err) {
		if ((err as Error).message?.includes('not found')) return json({ error: 'connection not found' }, { status: 404 });
		throw err;
	}
};
