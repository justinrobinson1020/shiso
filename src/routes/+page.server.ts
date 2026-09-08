import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { monthView } from '$lib/server/read/month';
import { todayIso } from '$lib/dates';

export const load: PageServerLoad = ({ url }) => {
	const config = getConfig();
	const today = todayIso(config.timeZone);
	const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') ?? '') ? url.searchParams.get('month')! : today.slice(0, 7);
	return { view: monthView(getDb(), { month, todayIso: today, cadence: config.cadence }) };
};
