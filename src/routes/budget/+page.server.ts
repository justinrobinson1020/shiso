import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { budgetView } from '$lib/server/read/budget';
import { todayIso } from '$lib/dates';
export const load: PageServerLoad = ({ url }) => {
	const config = getConfig();
	const raw = url.searchParams.get('period');
	return { view: budgetView(getDb(), { periodId: raw && /^\d+$/.test(raw) ? Number(raw) : null, todayIso: todayIso(config.timeZone), cadence: config.cadence }) };
};
