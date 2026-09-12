import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { ledgerView, LEDGER_SORT_KEYS, type LedgerSortKey } from '$lib/server/read/ledger';
import { categoryTree } from '$lib/server/read/categories';
const int = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null);
const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
export const load: PageServerLoad = ({ url }) => {
	const p = url.searchParams; const page = Math.max(int(p.get('page')) ?? 1, 1);
	const sortRaw = p.get('sort'); const sort = (LEDGER_SORT_KEYS as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as LedgerSortKey) : null;
	const dir: 'asc' | 'desc' | null = sort ? (p.get('dir') === 'desc' ? 'desc' : p.get('dir') === 'asc' ? 'asc' : null) : null;
	const filter = { accountId: int(p.get('account')), periodId: int(p.get('period')), categoryId: int(p.get('category')), from: date(p.get('from')), to: date(p.get('to')), review: p.get('review') === '1', q: p.get('q'), limit: 100, offset: (page - 1) * 100, sort, dir };
	return { filter, page, sort: sort ? { key: sort as string, dir: (dir ?? 'asc') as 'asc' | 'desc' } : null, view: ledgerView(getDb(), filter), tree: categoryTree(getDb()) };
};
