/** Pure per-debt figures for the sheet's Debt block (P2 §4.1). Cents in, cents out; rates in basis points. */
export type PromoLike = { remaining: number; aprBps: number };

/** Σ open promo remaining, capped at what is owed. */
export function promoTotal(owed: number, promos: PromoLike[]): number {
	return Math.min(Math.max(0, owed), promos.reduce((s, p) => s + Math.max(0, p.remaining), 0));
}

/** The part of the balance that accrues at the regular APR. */
export function accruing(owed: number, promos: PromoLike[]): number {
	return Math.max(0, owed) - promoTotal(owed, promos);
}

export function interestEstimates(d: { owed: number; aprBps: number | null; promos: PromoLike[] }): { yearly: number; monthly: number; daily: number } {
	const yearly = Math.round(accruing(d.owed, d.promos) * (d.aprBps ?? 0) / 10000 + d.promos.reduce((s, p) => s + Math.max(0, p.remaining) * p.aprBps / 10000, 0));
	return { yearly, monthly: Math.round(yearly / 12), daily: Math.round(yearly / 365) };
}

/** Whole months from `todayIso` to `expiresOn`, floored at one so a monthly target always exists. */
export function monthsLeft(todayIso: string, expiresOn: string): number {
	const [ty, tm, td] = todayIso.split('-').map(Number), [ey, em, ed] = expiresOn.split('-').map(Number);
	let n = (ey - ty) * 12 + (em - tm);
	if (ed < td) n -= 1;
	return Math.max(1, n);
}

export function addMonths(ym: string, n: number): string {
	const y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
	const d = new Date(Date.UTC(y, m, 1));
	return d.toISOString().slice(0, 7);
}
