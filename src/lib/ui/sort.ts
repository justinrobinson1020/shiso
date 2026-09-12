/** Client-side column sorting for tables whose rows are already loaded. */
export type SortDir = 'asc' | 'desc';
export type SortState = { key: string; dir: SortDir } | null;
export type SortKind = 'text' | 'number' | 'date';

/** First click: text ascends, numbers and dates descend (largest amount, latest date first). Second click flips. */
export function nextSort(current: SortState, key: string, kind: SortKind): NonNullable<SortState> {
	if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
	return { key, dir: kind === 'text' ? 'asc' : 'desc' };
}

type Cell = string | number | boolean | null | undefined;
function compare(a: Cell, b: Cell): number {
	if (a == null && b == null) return 0;
	if (a == null) return 1;   // nulls last in either direction
	if (b == null) return -1;
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
	return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort by `state.key`; a missing key or null state returns the rows in their given order. `pick` reads a cell when the key is not a plain property. */
export function sortRows<T>(rows: readonly T[], state: SortState, pick?: (row: T, key: string) => Cell): T[] {
	if (!state) return [...rows];
	const get = (r: T) => (pick ? pick(r, state.key) : (r as Record<string, unknown>)[state.key] as Cell);
	const sign = state.dir === 'asc' ? 1 : -1;
	return rows.map((r, i) => ({ r, i, v: get(r) }))
		.sort((x, y) => {
			const nullOrder = (x.v == null) !== (y.v == null) ? (x.v == null ? 1 : -1) : 0;   // nulls last regardless of direction
			return nullOrder || sign * compare(x.v, y.v) || x.i - y.i;
		})
		.map((x) => x.r);
}
