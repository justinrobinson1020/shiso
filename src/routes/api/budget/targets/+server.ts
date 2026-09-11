import { handle, readJson, cents, isoDate, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { setTarget } from '$lib/server/budget/targets';
import { TARGET_KINDS, type TargetKind } from '$lib/server/db/schema';
export const POST = handle(async ({ request }) => {
	const b = await readJson<Record<string, unknown>>(request);
	if (!(TARGET_KINDS as readonly string[]).includes(String(b.kind))) throw new ValidationError('kind must be monthly, refill, or by_date');
	setTarget(getDb(), cents(b.categoryId, 'categoryId'), { kind: b.kind as TargetKind, amount: cents(b.amount, 'amount'), targetDate: b.targetDate == null ? null : isoDate(b.targetDate, 'targetDate') });
	return { ok: true };
});
