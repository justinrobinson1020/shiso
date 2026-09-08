import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { accountsView } from '$lib/server/read/accounts';
import { todayIso } from '$lib/dates';
export const load: PageServerLoad = () => {
	const config = getConfig();
	return { view: accountsView(getDb(), { plaidConfigured: !!(config.plaid.clientId && config.plaid.secret) }), today: todayIso(config.timeZone) };
};
