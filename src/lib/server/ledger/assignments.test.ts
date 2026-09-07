import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId } from './categories';
import { ensurePeriods, periodIdForDate } from '../budget/periods';
import { assign, moveMoney, assignmentsForPeriod } from './assignments';

let db: Db; let p: number; let a: number; let b: number;
beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-01-31');
	p = periodIdForDate(db, '2026-01-05');
	const g = createGroup(db, 'Spending');
	a = createCategory(db, { groupId: g, name: 'A', kind: 'spending' });
	b = createCategory(db, { groupId: g, name: 'B', kind: 'spending' });
});

describe('assign', () => {
	it('upserts', () => {
		assign(db, p, a, 5000);
		assign(db, p, a, 7000);
		expect(assignmentsForPeriod(db, p)).toEqual([{ categoryId: a, assigned: 7000 }]);
	});
	it('refuses kinds without an envelope', () => {
		expect(() => assign(db, p, systemCategoryId(db, 'income'), 100)).toThrowError(/ASSIGN_NO_ENVELOPE/);
		expect(() => assign(db, p, systemCategoryId(db, 'transfer'), 100)).toThrowError(/ASSIGN_NO_ENVELOPE/);
	});
});

describe('moveMoney', () => {
	it('moves between envelopes in one step', () => {
		assign(db, p, a, 5000);
		moveMoney(db, p, a, b, 2000);
		const rows = Object.fromEntries(assignmentsForPeriod(db, p).map((r) => [r.categoryId, r.assigned]));
		expect(rows[a]).toBe(3000);
		expect(rows[b]).toBe(2000);
	});
	it('rejects non-positive amounts', () => {
		expect(() => moveMoney(db, p, a, b, 0)).toThrow();
	});
});
