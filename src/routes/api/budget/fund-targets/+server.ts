import { handle, readJson, cents } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { fundTargets } from '$lib/server/budget/targets';
export const POST = handle(async ({ request }) => {
	const b = await readJson<Record<string, unknown>>(request);
	return fundTargets(getDb(), { periodId: cents(b.periodId, 'periodId'), cadence: getConfig().cadence, categoryId: b.categoryId == null ? null : cents(b.categoryId, 'categoryId') });
});
