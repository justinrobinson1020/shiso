import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { debtView } from '$lib/server/read/debt';
import { todayIso } from '$lib/dates';
export const load: PageServerLoad = ({ url }) => {
	const config = getConfig();
	const raw = url.searchParams.get('period');
	return { view: debtView(getDb(), { periodId: raw && /^\d+$/.test(raw) ? Number(raw) : null, todayIso: todayIso(config.timeZone), cadence: config.cadence }) };
};
