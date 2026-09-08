import { handle, readJson, intParam, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConnection, setConnectionStatus } from '$lib/server/sync/connections';

export const POST = handle(async ({ request, params }) => {
	const b = await readJson<{ status?: string }>(request);
	if (b.status !== 'active' && b.status !== 'disabled') throw new ValidationError('status must be active or disabled');
	const id = intParam(params.id, 'id');
	getConnection(getDb(), id); // 404 when missing
	setConnectionStatus(getDb(), id, b.status);
	return { ok: true };
});
