import { eq } from 'drizzle-orm';
import { handle, readJson, intParam, cents } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { bills } from '$lib/server/db/schema';
import { updateBill, setBillActive, type NewBill } from '$lib/server/bills/bills';
import { scheduleFields, commonFields, regenerate } from '../bills-shared';

export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const b = await readJson<Record<string, unknown>>(request);
	const db = getDb();
	const patch = { ...commonFields(b, true), ...scheduleFields(b, true) } as Partial<NewBill>;
	if (b.payFromAccountId !== undefined) patch.payFromAccountId = cents(b.payFromAccountId, 'payFromAccountId');
	if (b.autopay !== undefined) patch.autopay = b.autopay === true;
	if (b.variable !== undefined) patch.variable = b.variable === true;
	if (b.linkedDebtAccountId !== undefined) patch.linkedDebtAccountId = b.linkedDebtAccountId == null ? null : cents(b.linkedDebtAccountId, 'linkedDebtAccountId');
	if (!db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()) throw new Error(`bill ${id} not found`);
	if (Object.keys(patch).length) updateBill(db, id, patch);
	if (b.active !== undefined) setBillActive(db, id, b.active === true);
	regenerate();
	return { ok: true };
});
