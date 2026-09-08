import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, categories, categoryGroups, type CategoryKind } from '../db/schema';
import { InvariantError } from './errors';
import { nowIso } from '$lib/dates';

export function createGroup(db: DbOrTx, name: string, sort = 0): number {
	return db.insert(categoryGroups).values({ name, sort }).returning({ id: categoryGroups.id }).get().id;
}

export function createCategory(
	db: DbOrTx,
	input: { groupId: number; name: string; kind: CategoryKind; accountId?: number | null; sort?: number; isSystem?: boolean }
): number {
	let accountId: number | null = null;
	if (input.kind === 'debt_payment') {
		if (input.accountId == null) throw new InvariantError('DEBT_CATEGORY_NEEDS_ACCOUNT');
		const acct = db.select().from(accounts).where(eq(accounts.id, input.accountId)).get();
		if (!acct) throw new InvariantError('DEBT_CATEGORY_NEEDS_ACCOUNT', `account ${input.accountId} not found`);
		if (!acct.isDebt) throw new InvariantError('DEBT_CATEGORY_ACCOUNT_NOT_DEBT');
		if (paymentCategoryForAccount(db, input.accountId) != null) throw new InvariantError('DEBT_CATEGORY_DUPLICATE');
		accountId = input.accountId;
	}
	return db
		.insert(categories)
		.values({ groupId: input.groupId, name: input.name, kind: input.kind, accountId, sort: input.sort ?? 0, isSystem: input.isSystem ?? false })
		.returning({ id: categories.id })
		.get().id;
}

const touch = () => ({ updatedAt: nowIso() });

export function renameCategory(db: DbOrTx, id: number, name: string): void {
	db.update(categories).set({ name, ...touch() }).where(eq(categories.id, id)).run();
}

export function hideCategory(db: DbOrTx, id: number, hidden: boolean): void {
	db.update(categories).set({ hidden, ...touch() }).where(eq(categories.id, id)).run();
}

export function moveCategory(db: DbOrTx, id: number, groupId: number, sort: number): void {
	db.update(categories).set({ groupId, sort, ...touch() }).where(eq(categories.id, id)).run();
}

export function updateCategory(db: DbOrTx, id: number, patch: {
	name?: string; kind?: CategoryKind; accountId?: number | null; hidden?: boolean; groupId?: number; sort?: number;
}): void {
	const row = db.select().from(categories).where(eq(categories.id, id)).get();
	if (!row) throw new Error(`category ${id} not found`);
	const set: Partial<typeof categories.$inferInsert> = { ...touch() };
	if (patch.name !== undefined) set.name = patch.name;
	if (patch.hidden !== undefined) set.hidden = patch.hidden;
	if (patch.groupId !== undefined) set.groupId = patch.groupId;
	if (patch.sort !== undefined) set.sort = patch.sort;
	if (patch.kind !== undefined || patch.accountId !== undefined) {
		const kind = patch.kind ?? row.kind;
		if (row.isSystem && kind !== row.kind) throw new InvariantError('SYSTEM_CATEGORY_KIND');
		if (kind === 'debt_payment') {
			const accountId = patch.accountId === undefined ? row.accountId : patch.accountId;
			if (accountId == null) throw new InvariantError('DEBT_CATEGORY_NEEDS_ACCOUNT');
			const acct = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
			if (!acct) throw new InvariantError('DEBT_CATEGORY_NEEDS_ACCOUNT', `account ${accountId} not found`);
			if (!acct.isDebt) throw new InvariantError('DEBT_CATEGORY_ACCOUNT_NOT_DEBT');
			const other = paymentCategoryForAccount(db, accountId);
			if (other != null && other !== id) throw new InvariantError('DEBT_CATEGORY_DUPLICATE');
			set.kind = kind; set.accountId = accountId;
		} else {
			set.kind = kind; set.accountId = null;
		}
	}
	db.update(categories).set(set).where(eq(categories.id, id)).run();
}

export function paymentCategoryForAccount(db: DbOrTx, accountId: number): number | null {
	const row = db
		.select({ id: categories.id })
		.from(categories)
		.where(and(eq(categories.kind, 'debt_payment'), eq(categories.accountId, accountId)))
		.get();
	return row?.id ?? null;
}

type SystemKind = 'income' | 'transfer' | 'reconciliation' | 'interest' | 'fee';
const SYSTEM: { kind: SystemKind; name: string }[] = [
	{ kind: 'income', name: 'Income' },
	{ kind: 'transfer', name: 'Transfer' },
	{ kind: 'reconciliation', name: 'Reconciliation' },
	{ kind: 'interest', name: 'Interest' },
	{ kind: 'fee', name: 'Fees' }
];

export function seedDefaultCategories(db: DbOrTx): void {
	const exists = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'System')).get();
	if (exists) return;
	db.transaction((tx) => {
		const system = createGroup(tx, 'System', 0);
		SYSTEM.forEach((s, i) => createCategory(tx, { groupId: system, name: s.name, kind: s.kind, sort: i, isSystem: true }));
		createGroup(tx, 'Bills', 1);
		const spending = createGroup(tx, 'Spending', 2);
		createCategory(tx, { groupId: spending, name: 'Uncategorized', kind: 'spending', sort: 999, isSystem: true });
		createGroup(tx, 'Debt Payments', 3);
		createGroup(tx, 'Savings', 4);
	});
}

/** The seeded row for `kind`. User categories may share the kind; they are never `is_system`. */
export function systemCategoryId(db: DbOrTx, kind: SystemKind): number {
	const row = db
		.select({ id: categories.id })
		.from(categories)
		.where(and(eq(categories.kind, kind), eq(categories.isSystem, true)))
		.orderBy(asc(categories.id))
		.get();
	if (!row) throw new Error(`system category ${kind} missing; run seedDefaultCategories`);
	return row.id;
}

/** The seeded catch-all. Found by flag, so renaming it is safe. */
export function uncategorizedId(db: DbOrTx): number {
	const row = db
		.select({ id: categories.id })
		.from(categories)
		.where(and(eq(categories.kind, 'spending'), eq(categories.isSystem, true)))
		.orderBy(asc(categories.id))
		.get();
	if (!row) throw new Error('Uncategorized category missing; run seedDefaultCategories');
	return row.id;
}
