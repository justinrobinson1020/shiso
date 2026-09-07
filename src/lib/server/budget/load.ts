import { alias } from 'drizzle-orm/sqlite-core';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, accountBalances, budgetAssignments, categories, periods, transactions, transactionSplits } from '../db/schema';
import { computeBudget, type BudgetInput, type BudgetResult } from './envelope';

export function loadBudgetInput(db: DbOrTx): BudgetInput {
	const accountRows = db.select({ id: accounts.id, type: accounts.type, onBudget: accounts.onBudget }).from(accounts).all();
	const categoryRows = db.select({ id: categories.id, kind: categories.kind, accountId: categories.accountId }).from(categories).all();
	const periodRows = db.select({ id: periods.id, startDate: periods.startDate }).from(periods).all();

	const peer = alias(transactions, 'peer');
	const splitRows = db
		.select({
			transactionId: transactionSplits.transactionId,
			accountId: transactions.accountId,
			periodId: transactions.periodId,
			categoryId: transactionSplits.categoryId,
			amount: transactionSplits.amount,
			transferPeerAccountId: peer.accountId,
			source: transactions.source
		})
		.from(transactionSplits)
		.innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
		.leftJoin(peer, eq(transactions.transferPeerId, peer.id))
		.where(isNull(transactions.deletedAt))
		.all();

	// Latest balance row per account; fall back to the live transaction sum.
	const latest = new Map<number, number>();
	const balanceRows = db
		.select({ accountId: accountBalances.accountId, current: accountBalances.current })
		.from(accountBalances)
		.orderBy(desc(accountBalances.asOf), desc(accountBalances.id))
		.all();
	for (const b of balanceRows) if (!latest.has(b.accountId)) latest.set(b.accountId, b.current);
	const sums = db
		.select({ accountId: transactions.accountId, total: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
		.from(transactions)
		.where(isNull(transactions.deletedAt))
		.groupBy(transactions.accountId)
		.all();
	const sumBy = new Map(sums.map((s) => [s.accountId, s.total]));
	const balances = accountRows.map((a) => ({ accountId: a.id, current: latest.get(a.id) ?? sumBy.get(a.id) ?? 0 }));

	const assignmentRows = db
		.select({ periodId: budgetAssignments.periodId, categoryId: budgetAssignments.categoryId, assigned: budgetAssignments.assigned })
		.from(budgetAssignments)
		.all();

	return {
		accounts: accountRows,
		categories: categoryRows,
		periods: periodRows,
		splits: splitRows.map((s) => ({ ...s, transferPeerAccountId: s.transferPeerAccountId ?? null })),
		assignments: assignmentRows,
		balances
	};
}

export function budgetForPeriod(db: DbOrTx, periodId: number): BudgetResult {
	return computeBudget(loadBudgetInput(db), periodId);
}
