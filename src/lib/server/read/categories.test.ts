import { describe, it, expect } from 'vitest';
import { setTarget } from '../budget/targets';
import { fixture } from '../test/fixture';
import { createTransaction } from '../ledger/transactions';
import { setProviderCategoryMap } from '../sync/postprocess';
import { categoryTree, providerCategoryMapView } from './categories';

describe('categoryTree', () => {
	it('lists groups in sort order with their categories, debt accounts, and kinds', () => {
		const f = fixture();
		const t = categoryTree(f.db);
		expect(t.groups.map((g) => g.name)).toEqual(['System', 'Bills', 'Spending', 'Debt Payments', 'Savings']);
		const debt = t.groups.find((g) => g.name === 'Debt Payments')!;
		expect(debt.categories[0]).toMatchObject({ name: 'Sapphire', kind: 'debt_payment', accountId: f.card, isSystem: false });
		expect(t.debtAccounts).toEqual([{ id: f.card, name: 'Sapphire' }]);
		expect(t.kinds).toContain('spending');
	});
});

describe('providerCategoryMapView', () => {
	it('returns the saved map and the distinct provider categories seen, most common first', () => {
		const f = fixture();
		setProviderCategoryMap(f.db, { FOOD_AND_DRINK_GROCERIES: f.groceries });
		createTransaction(f.db, { accountId: f.checking, externalId: 'a', postedDate: f.today, amount: -100, payeeRaw: 'A', providerCategory: 'TRAVEL', source: 'sync' });
		createTransaction(f.db, { accountId: f.checking, externalId: 'b', postedDate: f.today, amount: -200, payeeRaw: 'B', providerCategory: 'TRAVEL', source: 'sync' });
		createTransaction(f.db, { accountId: f.checking, externalId: 'c', postedDate: f.today, amount: -300, payeeRaw: 'C', providerCategory: 'FOOD_AND_DRINK_GROCERIES', source: 'sync' });
		const view = providerCategoryMapView(f.db);
		expect(view.map).toEqual({ FOOD_AND_DRINK_GROCERIES: f.groceries });
		expect(view.providerCategories).toEqual([
			{ key: 'TRAVEL', count: 2 },
			{ key: 'FOOD_AND_DRINK_GROCERIES', count: 1 }
		]);
	});
});

describe('categoryTree targets (P4)', () => {
	it('carries the saved target per category', () => {
		const f = fixture();
		setTarget(f.db, f.groceries, { kind: 'refill', amount: 25000, targetDate: null });
		const t = categoryTree(f.db).groups.flatMap((g) => g.categories);
		expect(t.find((c) => c.id === f.groceries)!.target).toEqual({ kind: 'refill', amount: 25000, targetDate: null });
		expect(t.find((c) => c.id === f.rent)!.target).toBeNull();
	});
});
