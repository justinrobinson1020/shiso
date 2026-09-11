import { handle, readJson, cents, isoDate, intParam, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { updatePromo } from '$lib/server/debt/plan';
export const POST = handle(async ({ request, params }) => {
	const b = await readJson<Record<string, unknown>>(request);
	const patch: Parameters<typeof updatePromo>[2] = {};
	if (b.description !== undefined) { if (typeof b.description !== 'string' || !b.description.trim()) throw new ValidationError('description is required'); patch.description = b.description.trim(); }
	if (b.remainingAmount !== undefined) patch.remainingAmount = cents(b.remainingAmount, 'remainingAmount');
	if (b.aprBps !== undefined) patch.aprBps = cents(b.aprBps, 'aprBps');
	if (b.expiresOn !== undefined) patch.expiresOn = isoDate(b.expiresOn, 'expiresOn');
	updatePromo(getDb(), intParam(params.id, 'id'), patch);
	return { ok: true };
});
