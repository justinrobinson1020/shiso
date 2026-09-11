import { handle, readJson, cents } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { fundShortfall } from '$lib/server/debt/plan';
export const POST = handle(async ({ request }) => {
	const b = await readJson<Record<string, unknown>>(request);
	return fundShortfall(getDb(), { periodId: cents(b.periodId, 'periodId'), accountId: cents(b.accountId, 'accountId') });
});
