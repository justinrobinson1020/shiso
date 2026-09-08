import { eq } from 'drizzle-orm';
import { openMemoryDatabase, type Db } from '../db';
import { categoryGroups } from '../db/schema';
import { seedDefaultCategories, createCategory, systemCategoryId, uncategorizedId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { createConnection, upsertAccount } from '../sync/connections';

export const KEY = 'k'.repeat(44);
export const TODAY = '2026-09-08';

export function fixture() {
	const db: Db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-07-01', '2026-10-31');
	const group = (name: string) => db.select({ id: categoryGroups.id }).from(categoryGroups).where(eq(categoryGroups.name, name)).get()!.id;
	const groups = { bills: group('Bills'), spending: group('Spending'), debt: group('Debt Payments'), savings: group('Savings') };
	const conn = createConnection(db, { provider: 'manual', institutionName: 'Test Bank', appKey: KEY });
	const checking = upsertAccount(db, conn, { externalId: 'chk', name: 'Checking', type: 'checking' }).id;
	const savings = upsertAccount(db, conn, { externalId: 'sav', name: 'Savings', type: 'savings' }).id;
	const card = upsertAccount(db, conn, { externalId: 'card', name: 'Sapphire', type: 'credit' }).id;
	const groceries = createCategory(db, { groupId: groups.spending, name: 'Groceries', kind: 'spending' });
	const rent = createCategory(db, { groupId: groups.bills, name: 'Rent', kind: 'bill' });
	const cardPay = createCategory(db, { groupId: groups.debt, name: 'Sapphire', kind: 'debt_payment', accountId: card });
	return {
		db, conn, checking, savings, card, groceries, rent, cardPay, groups,
		income: systemCategoryId(db, 'income'), uncategorized: uncategorizedId(db), today: TODAY
	};
}
