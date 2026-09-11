import { asc, desc, eq, isNull, and } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, accountTerms, periods } from '../db/schema';
import { latestBalance, latestTerms } from '../sync/connections';
import { paymentCategoryForAccount } from '../ledger/categories';
import { budgetForPeriod } from '../budget/load';
import { currentPeriodId, type Cadence } from '../budget/periods';
import { debtMinimum, plannedExtrasForPeriod, openPromos } from '../debt/plan';
import { accruing, interestEstimates, monthsLeft } from '../debt/interest';
import { project, type Strategy, type Projection } from '../debt/projection';
import { debtTrend, type TrendRow } from '../debt/trend';

export type DebtRow = {
	id: number; name: string; type: string; owed: number; asOf: string | null; accruing: number;
	aprBps: number | null; promoAprBps: number | null; interest: { daily: number; monthly: number; yearly: number };
	minimum: number | null; nextDue: string | null; annualFee: number | null; openedOn: string | null; ageMonths: number | null;
	extra: number; planned: number; categoryId: number | null; available: number | null; shortfall: number;
	terms: { asOf: string; source: string; aprBps: number | null; promoAprBps: number | null; minPayment: number | null; nextDueDate: string | null; lastStatementBalance: number | null; annualFee: number | null }[];
};
export type StrategyRow = {
	strategy: Strategy; label: string; debtFreeMonth: string | null; totalInterest: number; interestSaved: number; capped: boolean;
	firstTarget: string | null; payoffs: { id: number; name: string; payoffMonth: string | null }[]; series: Projection['series'];
};
export type PromoRow = {
	id: number; accountId: number; accountName: string; description: string; original: number; remaining: number; aprBps: number;
	expiresOn: string; monthsLeft: number; monthlyTarget: number; plannedMonthly: number; underTarget: boolean;
};
export type DebtView = {
	today: string; startMonth: string; periodsPerMonth: number;
	period: { id: number; label: string; isCurrent: boolean }; periods: { id: number; label: string }[];
	readyToAssign: number;
	debts: DebtRow[];
	totals: { owed: number; accruing: number; interest: { daily: number; monthly: number; yearly: number }; minimum: number; extra: number; planned: number; shortfall: number };
	strategies: StrategyRow[];
	promos: PromoRow[];
	trend: TrendRow[];
};

const LABELS: Record<Strategy, string> = { plan: 'Plan', minimums: 'Minimums only', avalanche: 'Avalanche', snowball: 'Snowball' };

export function debtView(db: DbOrTx, opts: { periodId: number | null; todayIso: string; cadence: Cadence }): DebtView {
	const currentId = currentPeriodId(db, opts.cadence, opts.todayIso);
	const periodId = opts.periodId ?? currentId;
	const period = db.select().from(periods).where(eq(periods.id, periodId)).get();
	if (!period) throw new Error(`period ${periodId} not found`);
	const all = db.select({ id: periods.id, label: periods.label }).from(periods).orderBy(asc(periods.startDate)).all();
	const periodsPerMonth = opts.cadence === 'semi_monthly' ? 2 : 1;
	const budget = budgetForPeriod(db, periodId);
	const cells = budget.byPeriod.get(periodId);
	const extras = plannedExtrasForPeriod(db, periodId);
	const promos = openPromos(db);

	const rows = db.select().from(accounts).where(and(eq(accounts.isDebt, true), isNull(accounts.closedAt))).orderBy(asc(accounts.id)).all();
	const debts: DebtRow[] = rows.map((a) => {
		const b = latestBalance(db, a.id); const t = latestTerms(db, a.id);
		const owed = b ? -b.current : 0;
		const mine = promos.filter((p) => p.accountId === a.id).map((p) => ({ remaining: p.remainingAmount, aprBps: p.aprBps }));
		const minimum = debtMinimum(db, a.id);
		const extra = extras.get(a.id) ?? 0;
		const categoryId = paymentCategoryForAccount(db, a.id);
		const available = categoryId == null ? null : (cells?.get(categoryId)?.available ?? 0);
		const planned = (minimum ?? 0) + extra;
		const history = db.select().from(accountTerms).where(eq(accountTerms.accountId, a.id)).orderBy(desc(accountTerms.asOf), desc(accountTerms.id)).all();
		return {
			id: a.id, name: a.name, type: a.type, owed, asOf: b?.asOf ?? null, accruing: accruing(owed, mine),
			aprBps: t?.aprBps ?? null, promoAprBps: t?.promoAprBps ?? null, interest: interestEstimates({ owed, aprBps: t?.aprBps ?? null, promos: mine }),
			minimum, nextDue: t?.nextDueDate ?? null, annualFee: t?.annualFee ?? null, openedOn: a.openedOn, ageMonths: a.openedOn ? monthsLeft(a.openedOn, opts.todayIso) : null,
			extra, planned, categoryId, available, shortfall: available == null ? 0 : Math.max(0, planned - available),
			terms: history.map((h) => ({ asOf: h.asOf, source: h.source, aprBps: h.aprBps, promoAprBps: h.promoAprBps, minPayment: h.minPayment, nextDueDate: h.nextDueDate, lastStatementBalance: h.lastStatementBalance, annualFee: h.annualFee }))
		};
	}).sort((a, b) => (b.aprBps ?? -1) - (a.aprBps ?? -1) || b.owed - a.owed);

	const sum = (f: (d: DebtRow) => number) => debts.reduce((s, d) => s + f(d), 0);
	const totals = {
		owed: sum((d) => d.owed), accruing: sum((d) => d.accruing),
		interest: { daily: sum((d) => d.interest.daily), monthly: sum((d) => d.interest.monthly), yearly: sum((d) => d.interest.yearly) },
		minimum: sum((d) => d.minimum ?? 0), extra: sum((d) => d.extra), planned: sum((d) => d.planned), shortfall: sum((d) => d.shortfall)
	};

	const startMonth = opts.todayIso.slice(0, 7);
	const inputs = debts.map((d) => ({
		id: d.id, owed: d.owed, aprBps: d.aprBps, minimum: d.minimum, extra: d.extra * periodsPerMonth,
		promos: promos.filter((p) => p.accountId === d.id).map((p) => ({ remaining: p.remainingAmount, aprBps: p.aprBps, expiresOn: p.expiresOn }))
	}));
	const pool = totals.extra * periodsPerMonth;
	const nameOf = new Map(debts.map((d) => [d.id, d.name]));
	const runs = (['plan', 'minimums', 'avalanche', 'snowball'] as Strategy[]).map((s) => project(inputs, s, { startMonth, pool }));
	const baseline = runs[1].totalInterest;
	const strategies: StrategyRow[] = runs.map((r) => ({
		strategy: r.strategy, label: LABELS[r.strategy], debtFreeMonth: r.debtFreeMonth, totalInterest: r.totalInterest, interestSaved: baseline - r.totalInterest, capped: r.capped,
		firstTarget: r.firstTarget == null ? null : (nameOf.get(r.firstTarget) ?? null),
		payoffs: r.debts.map((d) => ({ id: d.id, name: nameOf.get(d.id) ?? String(d.id), payoffMonth: d.payoffMonth })), series: r.series
	}));

	const promoRows: PromoRow[] = promos.flatMap((p) => {
		const d = debts.find((x) => x.id === p.accountId); if (!d) return [];
		const left = monthsLeft(opts.todayIso, p.expiresOn);
		const target = Math.ceil(p.remainingAmount / left);
		const plannedMonthly = d.planned * periodsPerMonth;
		return [{ id: p.id, accountId: p.accountId, accountName: d.name, description: p.description, original: p.originalAmount, remaining: p.remainingAmount, aprBps: p.aprBps, expiresOn: p.expiresOn, monthsLeft: left, monthlyTarget: target, plannedMonthly, underTarget: plannedMonthly < target }];
	});

	return {
		today: opts.todayIso, startMonth, periodsPerMonth,
		period: { id: period.id, label: period.label, isCurrent: period.id === currentId }, periods: all,
		readyToAssign: budget.readyToAssign, debts, totals, strategies, promos: promoRows, trend: debtTrend(db, { throughIso: opts.todayIso })
	};
}
