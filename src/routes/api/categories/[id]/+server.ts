import { handle, readJson, intParam, cents, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { updateCategory } from '$lib/server/ledger/categories';
import { CATEGORY_KINDS, type CategoryKind } from '$lib/server/db/schema';

export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const b = await readJson<Record<string, unknown>>(request);
	const patch: Parameters<typeof updateCategory>[2] = {};
	if (typeof b.name === 'string') {
		if (!b.name.trim()) throw new ValidationError('name is required');
		patch.name = b.name.trim();
	}
	if (b.kind !== undefined) {
		if (!(CATEGORY_KINDS as readonly string[]).includes(String(b.kind))) throw new ValidationError('kind is invalid');
		patch.kind = b.kind as CategoryKind;
	}
	if (b.accountId !== undefined) patch.accountId = b.accountId == null ? null : cents(b.accountId, 'accountId');
	if (b.hidden !== undefined) {
		if (typeof b.hidden !== 'boolean') throw new ValidationError('hidden must be boolean');
		patch.hidden = b.hidden;
	}
	if (b.groupId !== undefined) patch.groupId = cents(b.groupId, 'groupId');
	if (b.sort !== undefined) patch.sort = cents(b.sort, 'sort');
	updateCategory(getDb(), id, patch);
	return { ok: true };
});
