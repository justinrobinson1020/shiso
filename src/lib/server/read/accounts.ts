import { asc, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, connections, syncRuns, ACCOUNT_TYPES } from '../db/schema';
import { latestBalance, latestTerms } from '../sync/connections';
import { driftForAccount } from '../reconcile';

export type AccountsView = {
	plaidConfigured: boolean;
	connections: {
		id: number;
		provider: string;
		institutionName: string;
		status: string;
		lastSuccessAt: string | null;
		lastError: string | null;
		lastRun: {
			startedAt: string;
			finishedAt: string | null;
			status: string;
			error: string | null;
			added: number;
			modified: number;
			removed: number;
			balancesWritten: number;
			termsWritten: number;
		} | null;
		accounts: {
			id: number;
			name: string;
			type: string;
			onBudget: boolean;
			isDebt: boolean;
			closedAt: string | null;
			mask: string | null;
			balance: { current: number; available: number | null; creditLimit: number | null; asOf: string; source: string } | null;
			drift: { providerBalance: number | null; ledgerBalance: number; drift: number | null; convention: string };
			terms: {
				asOf: string;
				source: string;
				aprBps: number | null;
				promoAprBps: number | null;
				minPayment: number | null;
				nextDueDate: string | null;
				lastStatementBalance: number | null;
				lastStatementDate: string | null;
				annualFee: number | null;
			} | null;
		}[];
	}[];
	types: readonly string[];
};

export function accountsView(db: DbOrTx, opts: { plaidConfigured: boolean }): AccountsView {
	const conns = db.select().from(connections).orderBy(asc(connections.id)).all();
	const accts = db.select().from(accounts).orderBy(sql`${accounts.closedAt} is null desc`, asc(accounts.id)).all();
	return {
		plaidConfigured: opts.plaidConfigured,
		types: ACCOUNT_TYPES,
		connections: conns.map((c) => {
			const run = db.select().from(syncRuns).where(eq(syncRuns.connectionId, c.id)).orderBy(desc(syncRuns.startedAt), desc(syncRuns.id)).get() ?? null;
			return {
				id: c.id,
				provider: c.provider,
				institutionName: c.institutionName,
				status: c.status,
				lastSuccessAt: c.lastSuccessAt,
				lastError: c.lastError,
				lastRun: run && {
					startedAt: run.startedAt,
					finishedAt: run.finishedAt,
					status: run.status,
					error: run.error,
					added: run.added,
					modified: run.modified,
					removed: run.removed,
					balancesWritten: run.balancesWritten,
					termsWritten: run.termsWritten
				},
				accounts: accts
					.filter((a) => a.connectionId === c.id)
					.map((a) => {
						const b = latestBalance(db, a.id);
						const t = latestTerms(db, a.id);
						const d = driftForAccount(db, a.id);
						return {
							id: a.id,
							name: a.name,
							type: a.type,
							onBudget: a.onBudget,
							isDebt: a.isDebt,
							closedAt: a.closedAt,
							mask: a.mask,
							balance: b && { current: b.current, available: b.available, creditLimit: b.creditLimit, asOf: b.asOf, source: b.source },
							drift: { providerBalance: d.providerBalance, ledgerBalance: d.ledgerBalance, drift: d.drift, convention: d.convention },
							terms: t && {
								asOf: t.asOf,
								source: t.source,
								aprBps: t.aprBps,
								promoAprBps: t.promoAprBps,
								minPayment: t.minPayment,
								nextDueDate: t.nextDueDate,
								lastStatementBalance: t.lastStatementBalance,
								lastStatementDate: t.lastStatementDate,
								annualFee: t.annualFee
							}
						};
					})
			};
		})
	};
}
