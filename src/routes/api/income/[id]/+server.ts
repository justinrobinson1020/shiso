import { eq } from 'drizzle-orm';
import { handle, readJson, intParam, cents } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { incomeSources } from '$lib/server/db/schema';
import { updateIncomeSource, setIncomeActive, clearPendingIncomeOccurrences, type NewIncome } from '$lib/server/bills/bills';
import { getConfig } from '$lib/server/config';
import { todayIso } from '$lib/dates';
import { scheduleFields, settleField, commonFields, regenerate } from '../../bills/bills-shared';

export const POST = handle(async ({ request, params }) => {
	const id = intParam(params.id, 'id');
	const b = await readJson<Record<string, unknown>>(request);
	const db = getDb();
	const schedule = { ...scheduleFields(b, true), ...settleField(b, true) };
	const patch = { ...commonFields(b, true), ...schedule } as Partial<NewIncome>;
	if (b.depositAccountId !== undefined) patch.depositAccountId = cents(b.depositAccountId, 'depositAccountId');
	if (!db.select({ id: incomeSources.id }).from(incomeSources).where(eq(incomeSources.id, id)).get()) throw new Error(`income source ${id} not found`);
	if (Object.keys(patch).length) updateIncomeSource(db, id, patch);
	// A changed schedule leaves pending occurrences at the old dates; regenerate rebuilds them.
	if (Object.keys(schedule).length) clearPendingIncomeOccurrences(db, id, todayIso(getConfig().timeZone));
	if (b.active !== undefined) setIncomeActive(db, id, b.active === true);
	regenerate();
	return { ok: true };
});
