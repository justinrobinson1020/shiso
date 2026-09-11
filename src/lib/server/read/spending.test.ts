import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createTransaction, linkTransfer } from '../ledger/transactions';
import { createCategory } from '../ledger/categories';
import { resolveRange, spendingView } from './spending';

describe('resolveRange', () => {
	it('resolves each kind with its previous range', () => {
		const f = fixture();
		expect(resolveRange(f.db, { kind: 'period', anchor: '2026-09-08', cadence: 'semi_monthly' })).toMatchObject({ start: '2026-09-01', end: '2026-09-15', prevStart: '2026-08-16', prevEnd: '2026-08-31', label: 'Sep 1–15, 2026' });
		expect(resolveRange(f.db, { kind: 'month', anchor: '2026-09-08', cadence: 'semi_monthly' })).toMatchObject({ start: '2026-09-01', end: '2026-09-30', prevStart: '2026-08-01', prevEnd: '2026-08-31', label: 'September 2026' });
		expect(resolveRange(f.db, { kind: 'quarter', anchor: '2026-09-08', cadence: 'semi_monthly' })).toMatchObject({ start: '2026-07-01', end: '2026-09-30', prevStart: '2026-04-01', prevEnd: '2026-06-30', label: 'Q3 2026' });
		expect(resolveRange(f.db, { kind: 'year', anchor: '2026-09-08', cadence: 'semi_monthly' })).toMatchObject({ start: '2026-01-01', end: '2026-12-31', prevStart: '2025-01-01', prevEnd: '2025-12-31', label: '2026' });
		expect(resolveRange(f.db, { kind: 'custom', anchor: '2026-09-01', end: '2026-09-10', cadence: 'semi_monthly' })).toMatchObject({ start: '2026-09-01', end: '2026-09-10', prevStart: '2026-08-22', prevEnd: '2026-08-31' });
	});
});

describe('spendingView', () => {
	it('groups by category and merchant, excludes bill-like kinds and transfers, and compares', () => {
		const f = fixture();
		const dining = createCategory(f.db, { groupId: f.groups.spending, name: 'Dining', kind: 'spending' });
		const add = (date: string, amount: number, payee: string, cat: number, account = f.card) =>
			createTransaction(f.db, { accountId: account, externalId: `${date}-${payee}-${amount}`, postedDate: date, amount, payeeRaw: payee, payee, source: 'sync', splits: [{ categoryId: cat, amount }] });
		add('2026-09-02', -4000, 'Whole Foods', f.groceries); add('2026-09-05', -6000, 'Whole Foods', f.groceries); add('2026-09-06', -2500, 'Cafe', dining);
		add('2026-09-03', -227445, 'Landlord', f.rent, f.checking);                       // bill kind → excluded by default
		add('2026-08-20', -3000, 'Whole Foods', f.groceries);                              // previous period
		const a = add('2026-09-04', -50000, 'PAYMENT', f.uncategorized, f.checking); const b = add('2026-09-04', 50000, 'PAYMENT', f.uncategorized); linkTransfer(f.db, a, b);
		const range = resolveRange(f.db, { kind: 'period', anchor: '2026-09-08', cadence: 'semi_monthly' });
		const v = spendingView(f.db, { range, filter: { compare: true }, cadence: 'semi_monthly' });
		expect(v.total).toBe(12500); expect(v.prevTotal).toBe(3000);
		expect(v.byCategory.map((c) => [c.name, c.amount, c.share, c.prevAmount])).toEqual([['Groceries', 10000, 0.8, 3000], ['Dining', 2500, 0.2, 0]]);
		expect(v.byMerchant[0]).toEqual({ payee: 'Whole Foods', count: 2, total: 10000, prevTotal: 3000 });
		expect(v.overTime.buckets).toHaveLength(1); expect(v.overTime.buckets[0]).toMatchObject({ total: 12500, prevTotal: 3000, byCategory: { [String(f.groceries)]: 10000, [String(dining)]: 2500 } });
		expect(spendingView(f.db, { range, filter: { includeExcluded: true }, cadence: 'semi_monthly' }).total).toBe(12500 + 227445);
		expect(spendingView(f.db, { range, filter: { accountId: f.checking }, cadence: 'semi_monthly' }).total).toBe(0);
		expect(spendingView(f.db, { range, filter: { merchant: 'Cafe' }, cadence: 'semi_monthly' }).byCategory.map((c) => c.name)).toEqual(['Dining']);
		expect(v.trends.months).toEqual(['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
		expect(v.trends.rows.find((r) => r.name === 'Groceries')).toMatchObject({ current: 10000, currentPerMonth: 20000, baseline: 3000, delta: 17000, series: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3000, 10000] });
		expect(v.trends.total).toMatchObject({ current: 12500, baseline: 3000 });
		expect(v.outliers).toEqual([]);
		const year = resolveRange(f.db, { kind: 'year', anchor: '2026-09-08', cadence: 'semi_monthly' });
		expect(spendingView(f.db, { range: year, filter: {}, cadence: 'semi_monthly' }).overTime.buckets.map((b) => b.key)).toEqual(['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11','2026-12']);
	});
});

describe('spendingView outliers', () => {
	it('flags a charge far above the category history from the twelve months before the range', () => {
		const f = fixture();
		const add = (date: string, amount: number, payee: string) =>
			createTransaction(f.db, { accountId: f.card, externalId: `${date}-${payee}-${amount}`, postedDate: date, amount, payeeRaw: payee, payee, source: 'sync', splits: [{ categoryId: f.groceries, amount }] });
		for (let i = 0; i < 10; i++) add(`2026-0${(i % 2) + 7}-${String(i + 1).padStart(2, '0')}`, -8000 - i * 100, i % 2 ? 'Whole Foods' : 'Trader Joes');
		const big = add('2026-09-05', -60000, 'Costco');
		const range = resolveRange(f.db, { kind: 'period', anchor: '2026-09-08', cadence: 'semi_monthly' });
		const v = spendingView(f.db, { range, filter: {}, cadence: 'semi_monthly' });
		expect(v.outliers).toHaveLength(1);
		expect(v.outliers[0]).toMatchObject({ id: big, payee: 'Costco', categoryName: 'Groceries', amount: 60000, reason: 'category' });
	});
});
