import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { billsView } from '$lib/server/read/bills';
import { categoryTree } from '$lib/server/read/categories';
import { todayIso } from '$lib/dates';
export const load: PageServerLoad = () => {
	const today = todayIso(getConfig().timeZone);
	return { view: billsView(getDb(), { todayIso: today }), tree: categoryTree(getDb()), today };
};
