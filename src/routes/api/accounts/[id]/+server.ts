import { handle, readJson, intParam, isoDate, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { updateAccount } from '$lib/server/sync/connections';
import { ACCOUNT_TYPES, type AccountType } from '$lib/server/db/schema';

export const POST = handle(async ({ request, params }) => {
	const b = await readJson<Record<string, unknown>>(request);
	const patch: Parameters<typeof updateAccount>[2] = {};
	if (b.name !== undefined) {
		if (typeof b.name !== 'string' || !b.name.trim()) throw new ValidationError('name must be non-empty');
		patch.name = b.name.trim();
	}
	if (b.type !== undefined) {
		if (!(ACCOUNT_TYPES as readonly string[]).includes(String(b.type))) throw new ValidationError('type is invalid');
		patch.type = b.type as AccountType;
	}
	if (b.onBudget !== undefined) {
		if (typeof b.onBudget !== 'boolean') throw new ValidationError('onBudget must be boolean');
		patch.onBudget = b.onBudget;
	}
	if (b.closedAt !== undefined) patch.closedAt = b.closedAt === null ? null : isoDate(b.closedAt, 'closedAt');
	updateAccount(getDb(), intParam(params.id, 'id'), patch);
	return { ok: true };
});
