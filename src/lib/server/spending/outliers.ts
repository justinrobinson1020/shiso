import { robustScore } from './stats';

/** P3 §3.2. `amount` is positive spending in cents. */
export type Charge = { id: number; date: string; payee: string; categoryId: number; categoryName: string; amount: number };
export type Outlier = { id: number; date: string; payee: string; categoryName: string; amount: number; usual: number; multiple: number; reason: 'category' | 'merchant'; score: number };
export type OutlierOptions = { minHistory?: number; floor?: number; threshold?: number };

export function findOutliers(current: Charge[], history: Charge[], opts: OutlierOptions = {}): Outlier[] {
	const minHistory = opts.minHistory ?? 8, floor = opts.floor ?? 2500, threshold = opts.threshold ?? 3;
	const byCat = new Map<number, number[]>(), byPayee = new Map<string, number[]>();
	for (const h of history) {
		if (h.amount <= 0) continue;
		byCat.set(h.categoryId, [...(byCat.get(h.categoryId) ?? []), h.amount]);
		byPayee.set(h.payee, [...(byPayee.get(h.payee) ?? []), h.amount]);
	}
	const out: Outlier[] = [];
	for (const c of current) {
		if (c.amount < floor) continue;
		for (const [reason, hist] of [['category', byCat.get(c.categoryId)], ['merchant', byPayee.get(c.payee)]] as const) {
			if (!hist || hist.length < minHistory) continue;
			const r = robustScore(c.amount, hist);
			if (r.score >= threshold && r.median > 0) {
				out.push({ id: c.id, date: c.date, payee: c.payee, categoryName: c.categoryName, amount: c.amount, usual: r.median, multiple: Math.round((c.amount / r.median) * 10) / 10, reason, score: r.score });
				break;
			}
		}
	}
	return out.sort((a, b) => b.multiple - a.multiple || b.amount - a.amount);
}
