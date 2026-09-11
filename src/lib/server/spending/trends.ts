/** P3 §3.1: monthly series and baselines. Amounts are positive spending in cents. */
export type MonthlyRow = { month: string; categoryId: number; categoryName: string; amount: number };
export type TrendInput = {
	/** The twelve history months, ascending, ending with the range's end month. */
	months: string[];
	/** Spending per category per month over `months` (may contain repeats; they are summed). */
	monthly: MonthlyRow[];
	/** Spending per category inside the selected range. */
	current: { categoryId: number; categoryName: string; amount: number }[];
	rangeDays: number;
	/** True unless the range is exactly one calendar month. */
	scaleToMonth: boolean;
	/** First month with any ledger row; months before it do not count toward the baseline. */
	firstLedgerMonth: string | null;
};
export type TrendRow = { categoryId: number; name: string; current: number; currentPerMonth: number; baseline: number | null; delta: number | null; deltaPct: number | null; series: number[] };
export type Trends = { months: string[]; totals: number[]; rows: TrendRow[]; total: TrendRow };

export function trendTable(input: TrendInput): Trends {
	const last = input.months[input.months.length - 1];
	const baselineMonths = input.months.filter((m) => m !== last && (input.firstLedgerMonth == null || m >= input.firstLedgerMonth));
	const byCM = new Map<string, number>();
	const names = new Map<number, string>();
	for (const r of input.monthly) { byCM.set(`${r.categoryId}:${r.month}`, (byCM.get(`${r.categoryId}:${r.month}`) ?? 0) + r.amount); names.set(r.categoryId, r.categoryName); }
	for (const c of input.current) names.set(c.categoryId, c.categoryName);
	const currentBy = new Map(input.current.map((c) => [c.categoryId, c.amount]));
	const perMonth = (v: number) => (input.scaleToMonth && input.rangeDays > 0 ? Math.round((v * 30) / input.rangeDays) : v);
	const row = (id: number, name: string, series: number[], current: number): TrendRow => {
		const hist = baselineMonths.map((m) => series[input.months.indexOf(m)]);
		const baseline = hist.length ? Math.round(hist.reduce((s, x) => s + x, 0) / hist.length) : null;
		const currentPerMonth = perMonth(current);
		const delta = baseline == null ? null : currentPerMonth - baseline;
		return { categoryId: id, name, current, currentPerMonth, baseline, delta, deltaPct: baseline != null && baseline >= 1000 && delta != null ? Math.round((delta / baseline) * 1000) / 1000 : null, series };
	};
	const rows = [...names].map(([id, name]) => row(id, name, input.months.map((m) => byCM.get(`${id}:${m}`) ?? 0), currentBy.get(id) ?? 0))
		.filter((r) => r.current > 0 || r.series.some((x) => x > 0))
		.sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity) || b.current - a.current);
	const totals = input.months.map((_, i) => rows.reduce((s, r) => s + r.series[i], 0));
	const total = row(0, 'All spending', totals, input.current.reduce((s, c) => s + c.amount, 0));
	return { months: input.months, totals, rows, total };
}
