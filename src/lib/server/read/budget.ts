import { asc, eq, isNull, and } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, categories, categoryGroups, periods } from '../db/schema';
import { budgetForPeriod } from '../budget/load';
import { NO_ENVELOPE_KINDS } from '../budget/envelope';
import { currentPeriodId, type Cadence } from '../budget/periods';

export type BudgetView = {
	period: { id: number; label: string; startDate: string; endDate: string; isCurrent: boolean };
	periods: { id: number; label: string }[];
	readyToAssign: number;
	groups: {
		id: number;
		name: string;
		categories: {
			id: number;
			name: string;
			kind: string;
			accountId: number | null;
			hidden: boolean;
			carried: number;
			assigned: number;
			activity: number;
			available: number;
			creditOverspend: number;
			cashOverspend: number;
		}[];
	}[];
	underfunded: { accountId: number; accountName: string; owed: number; available: number; underfunded: number }[];
};

export function budgetView(db: DbOrTx, opts: { periodId: number | null; todayIso: string; cadence: Cadence }): BudgetView {
	const currentId = currentPeriodId(db, opts.cadence, opts.todayIso);
	const periodId = opts.periodId ?? currentId;
	const period = db.select().from(periods).where(eq(periods.id, periodId)).get();
	if (!period) throw new Error(`period ${periodId} not found`);
	const all = db.select({ id: periods.id, label: periods.label }).from(periods).orderBy(asc(periods.startDate)).all();
	const result = budgetForPeriod(db, periodId);
	const cells = result.byPeriod.get(periodId) ?? new Map();
	const zero = { carried: 0, assigned: 0, activity: 0, available: 0, creditOverspend: 0, cashOverspend: 0 };
	const groupRows = db.select().from(categoryGroups).orderBy(asc(categoryGroups.sort), asc(categoryGroups.id)).all();
	const catRows = db.select().from(categories).orderBy(asc(categories.sort), asc(categories.id)).all();
	const groups = groupRows
		.filter((g) => g.name !== 'System')
		.map((g) => ({
			id: g.id,
			name: g.name,
			categories: catRows
				.filter((c) => c.groupId === g.id && !NO_ENVELOPE_KINDS.has(c.kind))
				.map((c) => ({
					id: c.id,
					name: c.name,
					kind: c.kind,
					accountId: c.accountId,
					hidden: c.hidden,
					...(cells.get(c.id) ?? zero)
				}))
		}))
		.filter((g) => g.categories.length > 0);
	const cards = db.select().from(accounts).where(and(eq(accounts.type, 'credit'), isNull(accounts.closedAt))).all();
	const underfunded = cards.flatMap((a) => {
		const cat = catRows.find((c) => c.kind === 'debt_payment' && c.accountId === a.id);
		const owed = result.cardBalanceOwed.get(a.id) ?? 0;
		if (!cat || owed <= 0) return [];
		return [{ accountId: a.id, accountName: a.name, owed, available: (cells.get(cat.id) ?? zero).available, underfunded: result.underfunded.get(a.id) ?? 0 }];
	});
	return {
		period: { id: period.id, label: period.label, startDate: period.startDate, endDate: period.endDate, isCurrent: period.id === currentId },
		periods: all,
		readyToAssign: result.readyToAssign,
		groups,
		underfunded
	};
}
