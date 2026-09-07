import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, connections, categories } from '../db/schema';
import {
	createGroup, createCategory, seedDefaultCategories, paymentCategoryForAccount,
	systemCategoryId, uncategorizedId, renameCategory
} from './categories';
import { InvariantError } from './errors';
import { eq } from 'drizzle-orm';

let db: Db;
let cardId: number;
let checkingId: number;

beforeEach(() => {
	db = openMemoryDatabase().db;
	const conn = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get();
	cardId = db.insert(accounts).values({ connectionId: conn.id, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	checkingId = db.insert(accounts).values({ connectionId: conn.id, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
});

describe('debt payment category invariants', () => {
	it('requires an account', () => {
		const g = createGroup(db, 'Debt');
		expect(() => createCategory(db, { groupId: g, name: 'Card', kind: 'debt_payment' }))
			.toThrow(InvariantError);
	});
	it('requires the account to be a debt account', () => {
		const g = createGroup(db, 'Debt');
		expect(() => createCategory(db, { groupId: g, name: 'Chk', kind: 'debt_payment', accountId: checkingId }))
			.toThrowError(/DEBT_CATEGORY_ACCOUNT_NOT_DEBT/);
	});
	it('allows one per account and finds it', () => {
		const g = createGroup(db, 'Debt');
		const id = createCategory(db, { groupId: g, name: 'Card', kind: 'debt_payment', accountId: cardId });
		expect(paymentCategoryForAccount(db, cardId)).toBe(id);
		expect(() => createCategory(db, { groupId: g, name: 'Card again', kind: 'debt_payment', accountId: cardId }))
			.toThrowError(/DEBT_CATEGORY_DUPLICATE/);
	});
	it('ignores account on non-debt kinds', () => {
		const g = createGroup(db, 'Spending');
		const id = createCategory(db, { groupId: g, name: 'Groceries', kind: 'spending', accountId: cardId });
		expect(db.select().from(categories).where(eq(categories.id, id)).get()?.accountId).toBeNull();
	});
});

describe('seedDefaultCategories', () => {
	it('creates system categories once', () => {
		seedDefaultCategories(db);
		seedDefaultCategories(db);
		expect(systemCategoryId(db, 'income')).toBeGreaterThan(0);
		expect(systemCategoryId(db, 'transfer')).toBeGreaterThan(0);
		expect(uncategorizedId(db)).toBeGreaterThan(0);
		expect(db.select().from(categories).all().filter((c) => c.kind === 'income').length).toBe(1);
	});
	it('finds the seeded row even when a user category shares the kind', () => {
		const g = createGroup(db, 'Extra');
		createCategory(db, { groupId: g, name: 'Side Gig', kind: 'income' });
		seedDefaultCategories(db);
		createCategory(db, { groupId: g, name: 'Rebates', kind: 'income' });
		const seeded = db.select().from(categories).where(eq(categories.name, 'Income')).get()!;
		expect(systemCategoryId(db, 'income')).toBe(seeded.id);
	});
	it('finds Uncategorized after the user renames it', () => {
		seedDefaultCategories(db);
		const id = uncategorizedId(db);
		renameCategory(db, id, 'Needs a category');
		expect(uncategorizedId(db)).toBe(id);
	});
});
