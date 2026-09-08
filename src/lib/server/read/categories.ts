import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, categories, categoryGroups, CATEGORY_KINDS, type CategoryKind } from '../db/schema';

export type CategoryTree = {
	groups: {
		id: number;
		name: string;
		sort: number;
		categories: {
			id: number;
			name: string;
			kind: CategoryKind;
			accountId: number | null;
			hidden: boolean;
			isSystem: boolean;
			sort: number;
			groupId: number;
		}[];
	}[];
	debtAccounts: { id: number; name: string }[];
	kinds: readonly CategoryKind[];
};

/** Every group and category incl. hidden and system; used by pickers in Ledger and Bills too. */
export function categoryTree(db: DbOrTx): CategoryTree {
	const groups = db.select().from(categoryGroups).orderBy(asc(categoryGroups.sort), asc(categoryGroups.id)).all();
	const cats = db.select().from(categories).orderBy(asc(categories.sort), asc(categories.id)).all();
	const debtAccounts = db
		.select({ id: accounts.id, name: accounts.name })
		.from(accounts)
		.where(eq(accounts.isDebt, true))
		.orderBy(asc(accounts.name))
		.all();
	return {
		groups: groups.map((g) => ({
			id: g.id,
			name: g.name,
			sort: g.sort,
			categories: cats
				.filter((c) => c.groupId === g.id)
				.map((c) => ({
					id: c.id,
					name: c.name,
					kind: c.kind,
					accountId: c.accountId,
					hidden: c.hidden,
					isSystem: c.isSystem,
					sort: c.sort,
					groupId: c.groupId
				}))
		})),
		debtAccounts,
		kinds: CATEGORY_KINDS
	};
}
