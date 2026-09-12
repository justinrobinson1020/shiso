import { describe, it, expect } from 'vitest';
import { nextSort, sortRows } from './sort';
const rows = [
	{ name: 'beta', amount: -500, date: '2026-09-02', note: null as string | null },
	{ name: 'Alpha', amount: 1200, date: '2026-08-30', note: 'x' },
	{ name: 'gamma', amount: -500, date: null as string | null, note: 'a' },
	{ name: 'delta', amount: 0, date: '2026-09-10', note: null }
];
describe('sortRows', () => {
	it('sorts text case-insensitively in either direction', () => {
		expect(sortRows(rows, { key: 'name', dir: 'asc' }).map((r) => r.name)).toEqual(['Alpha', 'beta', 'delta', 'gamma']);
		expect(sortRows(rows, { key: 'name', dir: 'desc' }).map((r) => r.name)).toEqual(['gamma', 'delta', 'beta', 'Alpha']);
	});
	it('sorts numbers numerically and keeps equal values in their original order', () => {
		expect(sortRows(rows, { key: 'amount', dir: 'desc' }).map((r) => r.name)).toEqual(['Alpha', 'delta', 'beta', 'gamma']);
		expect(sortRows(rows, { key: 'amount', dir: 'asc' }).map((r) => r.name)).toEqual(['beta', 'gamma', 'delta', 'Alpha']);
	});
	it('puts nulls last in both directions', () => {
		expect(sortRows(rows, { key: 'date', dir: 'desc' }).map((r) => r.name)).toEqual(['delta', 'beta', 'Alpha', 'gamma']);
		expect(sortRows(rows, { key: 'date', dir: 'asc' }).map((r) => r.name)).toEqual(['Alpha', 'beta', 'delta', 'gamma']);
		expect(sortRows(rows, { key: 'note', dir: 'asc' }).map((r) => r.name)).toEqual(['gamma', 'Alpha', 'beta', 'delta']);
	});
	it('returns a copy in the given order with no state, and reads through a picker', () => {
		expect(sortRows(rows, null)).toEqual(rows); expect(sortRows(rows, null)).not.toBe(rows);
		expect(sortRows(rows, { key: 'len', dir: 'desc' }, (r, k) => (k === 'len' ? r.name.length : null)).map((r) => r.name)).toEqual(['Alpha', 'gamma', 'delta', 'beta']);
	});
});
describe('nextSort', () => {
	it('starts text ascending and numbers or dates descending, then flips, and resets on a new column', () => {
		expect(nextSort(null, 'name', 'text')).toEqual({ key: 'name', dir: 'asc' });
		expect(nextSort(null, 'amount', 'number')).toEqual({ key: 'amount', dir: 'desc' });
		expect(nextSort(null, 'date', 'date')).toEqual({ key: 'date', dir: 'desc' });
		expect(nextSort({ key: 'amount', dir: 'desc' }, 'amount', 'number')).toEqual({ key: 'amount', dir: 'asc' });
		expect(nextSort({ key: 'amount', dir: 'asc' }, 'name', 'text')).toEqual({ key: 'name', dir: 'asc' });
	});
});
