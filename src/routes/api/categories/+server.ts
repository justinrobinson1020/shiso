import { handle, readJson, cents, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createCategory } from '$lib/server/ledger/categories';
import { CATEGORY_KINDS, type CategoryKind } from '$lib/server/db/schema';

export const POST = handle(async ({ request }) => {
	const b = await readJson<{ groupId: unknown; name?: string; kind?: string; accountId?: unknown }>(request);
	if (!b.name?.trim()) throw new ValidationError('name is required');
	if (!(CATEGORY_KINDS as readonly string[]).includes(b.kind ?? '')) throw new ValidationError('kind is invalid');
	const accountId = b.accountId == null ? null : cents(b.accountId, 'accountId');
	return {
		id: createCategory(getDb(), {
			groupId: cents(b.groupId, 'groupId'),
			name: b.name.trim(),
			kind: b.kind as CategoryKind,
			accountId
		})
	};
});
