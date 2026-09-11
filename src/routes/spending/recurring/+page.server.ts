import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { recurringView } from '$lib/server/read/recurring';
import { todayIso } from '$lib/dates';
export const load: PageServerLoad = ({ url }) => {
	const config = getConfig();
	return { view: recurringView(getDb(), { todayIso: todayIso(config.timeZone), includeExcluded: url.searchParams.get('all') === '1' }) };
};
