import { handle, readJson, cents } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createIncomeSource, type NewIncome } from '$lib/server/bills/bills';
import { scheduleFields, settleField, commonFields, regenerate } from '../bills/bills-shared';

export const POST = handle(async ({ request }) => {
	const b = await readJson<Record<string, unknown>>(request);
	const input = {
		...commonFields(b, false), ...scheduleFields(b, false), ...settleField(b, false),
		depositAccountId: cents(b.depositAccountId, 'depositAccountId')
	} as NewIncome;
	const id = createIncomeSource(getDb(), input);
	regenerate();
	return { id };
});
