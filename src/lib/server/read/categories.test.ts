import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { categoryTree } from './categories';

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
