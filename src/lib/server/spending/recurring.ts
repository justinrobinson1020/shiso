import { addDays } from '$lib/dates';
import { median } from './stats';

/** P3 §3.3. Charges are positive spending in cents. */
export type Charge = { date: string; payee: string; amount: number };
export type CadenceKey = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
export const CADENCES: { key: CadenceKey; days: number; band: [number, number]; perYear: number; minCharges: number }[] = [
	{ key: 'weekly', days: 7, band: [6, 8], perYear: 52, minCharges: 3 },
	{ key: 'biweekly', days: 14, band: [13, 15], perYear: 26, minCharges: 3 },
	{ key: 'monthly', days: 30, band: [27, 33], perYear: 12, minCharges: 3 },
	{ key: 'quarterly', days: 91, band: [85, 95], perYear: 4, minCharges: 3 },
	{ key: 'yearly', days: 365, band: [355, 375], perYear: 1, minCharges: 2 }
];
export type Recurring = { payee: string; cadence: CadenceKey; count: number; typical: number; last: string; next: string; overdue: boolean; covered: boolean; monthlyCost: number; matched: number; intervals: number };

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export function detectRecurring(charges: Charge[], opts: { todayIso: string; isCovered: (payee: string) => boolean; graceDays?: number }): Recurring[] {
	const grace = opts.graceDays ?? 5;
	const byPayee = new Map<string, Charge[]>();
	for (const c of charges) if (c.amount > 0) byPayee.set(c.payee, [...(byPayee.get(c.payee) ?? []), c]);
	const out: Recurring[] = [];
	for (const [payee, list] of byPayee) {
		// one charge per day: a same-day pair is a split or a duplicate, not a cadence
		const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date)).filter((c, i, arr) => i === 0 || c.date !== arr[i - 1].date);
		if (sorted.length < 2) continue;
		const gaps = sorted.slice(1).map((c, i) => daysBetween(sorted[i].date, c.date));
		let best: { cadence: (typeof CADENCES)[number]; matched: number } | null = null;
		for (const cadence of CADENCES) {
			if (sorted.length < cadence.minCharges) continue;
			const matched = gaps.filter((g) => g >= cadence.band[0] && g <= cadence.band[1]).length;
			if (matched / gaps.length >= 0.75 && (!best || matched > best.matched)) best = { cadence, matched };
		}
		if (!best) continue;
		const amounts = sorted.map((c) => c.amount); const typical = median(amounts);
		const stable = amounts.filter((a) => Math.abs(a - typical) <= typical * 0.15).length / amounts.length >= 0.75;
		if (!stable) continue;
		const last = sorted[sorted.length - 1].date; const next = addDays(last, best.cadence.days);
		out.push({
			payee, cadence: best.cadence.key, count: sorted.length, typical, last, next, overdue: next < addDays(opts.todayIso, -grace),
			covered: opts.isCovered(payee), monthlyCost: Math.round((typical * best.cadence.perYear) / 12), matched: best.matched, intervals: gaps.length
		});
	}
	return out.sort((a, b) => Number(a.covered) - Number(b.covered) || b.monthlyCost - a.monthlyCost || a.payee.localeCompare(b.payee));
}
