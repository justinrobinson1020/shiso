import { addMonths } from './interest';

/** One debt as the projection sees it (P2 §4.3). `extra` is the debt's own monthly extra under the Plan strategy; `minimum` null means unknown. */
export type DebtInput = { id: number; owed: number; aprBps: number | null; promos: { remaining: number; aprBps: number; expiresOn: string }[]; minimum: number | null; extra: number };
export type Strategy = 'plan' | 'minimums' | 'avalanche' | 'snowball';
export type Projection = {
	strategy: Strategy;
	debts: { id: number; payoffMonth: string | null; interest: number; stalled: boolean; promoRemainingAfterFirstMonth: number }[];
	totalInterest: number;
	debtFreeMonth: string | null;
	/** True when the horizon ended before every debt was gone. */
	capped: boolean;
	firstTarget: number | null;
	series: { month: string; owed: number }[];
};

type State = { id: number; aprBps: number; minimum: number; extra: number; accruing: number; promos: { remaining: number; aprBps: number; expiresOn: string }[]; interest: number; payoffMonth: string | null; stalled: boolean; promoAfterFirst: number };
const owedOf = (s: State) => s.accruing + s.promos.reduce((t, p) => t + p.remaining, 0);
const monthly = (balance: number, aprBps: number) => Math.round((balance * aprBps) / 120000);

/** Reduce `amount` across the promos (oldest expiry first) and return what is left unpaid. */
function payPromos(s: State, amount: number): number {
	for (const p of s.promos) { const x = Math.min(p.remaining, amount); p.remaining -= x; amount -= x; if (amount === 0) break; }
	return amount;
}
function payAccruing(s: State, amount: number): number { const x = Math.min(s.accruing, amount); s.accruing -= x; return amount - x; }

/**
 * Month-step every debt under a strategy. `pool` is the monthly extra shared by avalanche and snowball (the Plan strategy uses each debt's own
 * `extra`). Payments are fixed at minimum + extra; a paid-off debt's minimum joins the pool under avalanche and snowball only.
 * A debt whose payment does not exceed its monthly interest is held flat rather than compounded: it is reported as never paid off unless a
 * growing pool later reaches it. The walk ends when every open debt is flat, or at `maxMonths`.
 */
export function project(inputs: DebtInput[], strategy: Strategy, opts: { startMonth: string; pool?: number; maxMonths?: number }): Projection {
	const max = opts.maxMonths ?? 600;
	const states: State[] = inputs.filter((d) => d.owed > 0).map((d) => {
		const promos = d.promos.filter((p) => p.remaining > 0).map((p) => ({ ...p })).sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
		let promoSum = promos.reduce((s, p) => s + p.remaining, 0);
		// Promo cannot exceed what is owed; trim the newest promos first.
		for (let i = promos.length - 1; promoSum > d.owed && i >= 0; i--) { const cut = Math.min(promos[i].remaining, promoSum - d.owed); promos[i].remaining -= cut; promoSum -= cut; }
		return { id: d.id, aprBps: d.aprBps ?? 0, minimum: d.minimum ?? 0, extra: strategy === 'plan' ? d.extra : 0, accruing: d.owed - promoSum, promos: promos.filter((p) => p.remaining > 0), interest: 0, payoffMonth: null, stalled: false, promoAfterFirst: 0 };
	});
	const rolling = strategy === 'avalanche' || strategy === 'snowball';
	let pool = rolling ? (opts.pool ?? 0) : 0;
	const order = (open: State[]) => strategy === 'avalanche'
		? [...open].sort((a, b) => b.aprBps - a.aprBps || owedOf(b) - owedOf(a))
		: [...open].sort((a, b) => owedOf(a) - owedOf(b) || b.aprBps - a.aprBps);
	const series: Projection['series'] = [{ month: opts.startMonth, owed: states.reduce((s, x) => s + owedOf(x), 0) }];
	let firstTarget: number | null = null;
	let month = opts.startMonth, steps = 0;
	const monthInterest = (s: State) => monthly(s.accruing, s.aprBps) + s.promos.reduce((t, p) => t + monthly(p.remaining, p.aprBps), 0);
	while (states.some((s) => s.payoffMonth == null) && steps < max) {
		const first = `${month}-01`;
		const open = states.filter((s) => s.payoffMonth == null);
		// 0. fold expired promos before anything accrues
		for (const s of open) { for (const p of s.promos) if (p.expiresOn < first) { s.accruing += p.remaining; p.remaining = 0; } s.promos = s.promos.filter((p) => p.remaining > 0); }
		// 1. decide who moves: a debt whose payment does not exceed this month's interest is frozen (balance flat, no accrual) until the pool grows
		let spare = pool;
		const ordered = rolling ? order(open) : open;
		if (rolling && firstTarget == null && ordered.length) firstTarget = ordered[0].id;
		let paidOffThisMonth = false, anyMoved = false;
		for (const s of ordered) {
			const extraWanted = rolling ? spare : s.extra;
			const payment = Math.min(s.minimum + extraWanted, owedOf(s));
			if (payment <= monthInterest(s)) { s.stalled = true; continue; }
			s.stalled = false; anyMoved = true;
			// 2. interest
			const iAcc = monthly(s.accruing, s.aprBps); s.accruing += iAcc; s.interest += iAcc;
			for (const p of s.promos) { const ip = monthly(p.remaining, p.aprBps); p.remaining += ip; s.interest += ip; }
			// 3. payment: minimum to promos first, extra to accruing first; a rolling pool cascades down the order
			const minPart = Math.min(s.minimum, owedOf(s));
			let rest = payPromos(s, minPart); rest = payAccruing(s, rest);
			const extraPart = Math.min(extraWanted, owedOf(s));
			rest = payAccruing(s, extraPart); payPromos(s, rest);
			if (rolling) spare -= extraPart;
			if (steps === 0) s.promoAfterFirst = s.promos.reduce((t, p) => t + p.remaining, 0);
			if (owedOf(s) === 0) { s.payoffMonth = month; paidOffThisMonth = true; if (rolling) pool += s.minimum; }
		}
		if (!anyMoved) break;
		series.push({ month, owed: states.reduce((t, x) => t + owedOf(x), 0) });
		steps++; month = addMonths(opts.startMonth, steps);
		if (!paidOffThisMonth && open.every((s) => s.stalled || s.payoffMonth != null) && open.some((s) => s.stalled)) break;
	}
	const capped = states.some((s) => s.payoffMonth == null);
	const payoffs = states.map((s) => s.payoffMonth).filter((m): m is string => m != null);
	return {
		strategy,
		debts: states.map((s) => ({ id: s.id, payoffMonth: s.payoffMonth, interest: s.interest, stalled: s.payoffMonth == null, promoRemainingAfterFirstMonth: s.promoAfterFirst })),
		totalInterest: states.reduce((t, s) => t + s.interest, 0),
		debtFreeMonth: capped ? null : payoffs.length ? payoffs.reduce((a, b) => (a > b ? a : b)) : opts.startMonth,
		capped, firstTarget, series
	};
}
