/** Client-side column sorting for tables whose rows are already loaded. */
export type SortDir = 'asc' | 'desc';
export type SortState = { key: string; dir: SortDir } | null;
export type SortKind = 'text' | 'number' | 'date';

/** First click: text ascends, numbers and dates descend (largest amount, latest date first). Second click flips. */
export function nextSort(current: SortState, key: string, kind: SortKind): NonNullable<SortState> {
	if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
	return { key, dir: kind === 'text' ? 'asc' : 'desc' };
}

export type Cell = string | number | boolean | null | undefined;
/** One reader per sortable column key. Typed against the row, so a misspelled property is a compile error. */
export type SortColumns<T> = Readonly<Record<string, (row: T) => Cell>>;
function toCell(v: unknown): Cell { return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null; }
function compare(a: Cell, b: Cell): number {
	if (a == null && b == null) return 0;
	if (a == null) return 1;   // nulls last in either direction
	if (b == null) return -1;
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
	return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort by `state.key`; a null state returns the rows in their given order. `columns` reads each sortable key; without it (or for a key it lacks) the row's own property of that name is used, and non-scalar values sort as null. */
export function sortRows<T>(rows: readonly T[], state: SortState, columns?: SortColumns<T>): T[] {
	if (!state) return [...rows];
	const read = columns?.[state.key];
	const get = (r: T): Cell => (read ? read(r) : toCell(Reflect.get(Object(r), state.key)));
	const sign = state.dir === 'asc' ? 1 : -1;
	return rows.map((r, i) => ({ r, i, v: get(r) }))
		.sort((x, y) => {
			const nullOrder = (x.v == null) !== (y.v == null) ? (x.v == null ? 1 : -1) : 0;   // nulls last regardless of direction
			return nullOrder || sign * compare(x.v, y.v) || x.i - y.i;
		})
		.map((x) => x.r);
}
