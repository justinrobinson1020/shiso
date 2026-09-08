import { handle, readJson, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createGroup } from '$lib/server/ledger/categories';

export const POST = handle(async ({ request }) => {
	const b = await readJson<{ name?: string }>(request);
	if (!b.name?.trim()) throw new ValidationError('name is required');
	return { id: createGroup(getDb(), b.name.trim(), 100) };
});
