import { handle, readJson, cents } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { createBill, type NewBill } from '$lib/server/bills/bills';
import { scheduleFields, commonFields, regenerate } from './bills-shared';

export const POST = handle(async ({ request }) => {
	const b = await readJson<Record<string, unknown>>(request);
	const input = {
		...commonFields(b, false), ...scheduleFields(b, false),
		payFromAccountId: cents(b.payFromAccountId, 'payFromAccountId'),
		autopay: b.autopay === true, variable: b.variable === true,
		linkedDebtAccountId: b.linkedDebtAccountId == null ? null : cents(b.linkedDebtAccountId, 'linkedDebtAccountId')
	} as NewBill;
	const id = createBill(getDb(), input);
	regenerate();
	return { id };
});
