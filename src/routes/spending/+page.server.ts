import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { resolveRange, spendingView, type RangeKind } from '$lib/server/read/spending';
import { todayIso } from '$lib/dates';
const KINDS: RangeKind[] = ['period', 'month', 'quarter', 'year', 'custom'];
const int = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null);
const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
export const load: PageServerLoad = ({ url }) => {
	const config = getConfig(); const p = url.searchParams; const today = todayIso(config.timeZone);
	const kind = (KINDS as string[]).includes(p.get('kind') ?? '') ? (p.get('kind') as RangeKind) : 'period';
	const range = resolveRange(getDb(), { kind, anchor: date(p.get('anchor')) ?? today, end: date(p.get('end')), cadence: config.cadence });
	const filter = { accountId: int(p.get('account')), groupId: int(p.get('group')), merchant: p.get('merchant') || null, includeExcluded: p.get('all') === '1', compare: p.get('compare') === '1' };
	return { view: spendingView(getDb(), { range, filter, cadence: config.cadence, todayIso: today }), today };
};
