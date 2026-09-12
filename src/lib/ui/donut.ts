/** Slice math for a donut of spending by category: the top N slices plus an "Other" slice, with shares and SVG arc paths. */
export type DonutSlice = { id: number | null; name: string; amount: number; share: number; path: string; color: string };
const PALETTE = Array.from({ length: 9 }, (_, i) => `var(--chart-${i + 1})`);

function arc(cx: number, cy: number, r: number, r0: number, a0: number, a1: number): string {
	const p = (rr: number, a: number) => [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
	const [x0, y0] = p(r, a0), [x1, y1] = p(r, a1), [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
	const large = a1 - a0 > Math.PI ? 1 : 0;
	const f = (n: number) => n.toFixed(2);
	return `M${f(x0)},${f(y0)} A${r},${r} 0 ${large} 1 ${f(x1)},${f(y1)} L${f(x2)},${f(y2)} A${r0},${r0} 0 ${large} 0 ${f(x3)},${f(y3)} Z`;
}

/**
 * Positive spending only (refunds cannot be a slice); sorted largest first; everything past `max − 1`
 * folds into "Other". Shares sum to 1 over the positive total. Angles start at twelve o'clock.
 */
export function donutSlices(rows: { id: number; name: string; amount: number }[], opts: { max?: number; cx?: number; cy?: number; r?: number; r0?: number } = {}): DonutSlice[] {
	const { max = 8, cx = 110, cy = 110, r = 100, r0 = 62 } = opts;
	const positive = rows.filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
	const total = positive.reduce((s, x) => s + x.amount, 0);
	if (total === 0) return [];
	const kept = positive.length > max ? positive.slice(0, max - 1) : positive;
	const rest = positive.slice(kept.length);
	const items: { id: number | null; name: string; amount: number }[] = [...kept];
	if (rest.length) items.push({ id: null, name: 'Other', amount: rest.reduce((s, x) => s + x.amount, 0) });
	let a = -Math.PI / 2;
	return items.map((it, i) => {
		const share = it.amount / total;
		const a1 = a + share * 2 * Math.PI;
		// A single full-circle slice needs two arcs to render; nudge the end by an epsilon instead.
		const end = items.length === 1 ? a1 - 1e-4 : a1;
		const slice = { ...it, share, path: arc(cx, cy, r, r0, a, end), color: PALETTE[i % PALETTE.length] };
		a = a1;
		return slice;
	});
}
