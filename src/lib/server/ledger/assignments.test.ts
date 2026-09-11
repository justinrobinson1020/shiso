import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId } from './categories';
import { ensurePeriods, periodIdForDate } from '../budget/periods';
import { assign, moveMoney, assignmentsForPeriod } from './assignments';
import { InvariantError } from './errors';
import { fixture } from '../test/fixture';
import { setSetting, BUDGET_START_KEY } from '../settings';
import { fundTargets, setTarget } from '../budget/targets';
import { fundShortfall } from '../debt/plan';

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
		expect(() => assign(db, p, systemCategoryId(db, 'reconciliation'), 100)).toThrowError(/ASSIGN_NO_ENVELOPE/);
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
		expect(() => moveMoney(db, p, a, b, 0)).toThrowError(/MOVE_AMOUNT_NOT_POSITIVE/);
		expect(() => moveMoney(db, p, a, b, -5)).toThrowError(/MOVE_AMOUNT_NOT_POSITIVE/);
	});
	it('rejects moving money from a category to itself and leaves no row behind', () => {
		expect(() => moveMoney(db, p, a, a, 100)).toThrowError(/MOVE_SAME_CATEGORY/);
		expect(assignmentsForPeriod(db, p)).toEqual([]);
	});
});

describe('budget start', () => {
	it('refuses assignments in a period before budget_start', () => {
		const f = fixture(); setSetting(f.db, BUDGET_START_KEY, '2026-08-01');
		const july = periodIdForDate(f.db, '2026-07-05');
		expect(() => assign(f.db, july, f.groceries, 100)).toThrow(InvariantError);
		expect(() => moveMoney(f.db, july, f.groceries, f.rent, 100)).toThrow(/PERIOD_BEFORE_BUDGET_START/);
		assign(f.db, periodIdForDate(f.db, '2026-08-01'), f.groceries, 100);   // the start period itself is a budget period
	});
	it('refuses the writers that compute envelopes before assigning with the same code, not a crash', () => {
		const f = fixture(); setSetting(f.db, BUDGET_START_KEY, '2026-08-01');
		const july = periodIdForDate(f.db, '2026-07-05');
		setTarget(f.db, f.groceries, { kind: 'monthly', amount: 40000, targetDate: null });
		expect(() => fundTargets(f.db, { periodId: july, cadence: 'semi_monthly' })).toThrow(/PERIOD_BEFORE_BUDGET_START/);
		expect(() => fundShortfall(f.db, { periodId: july, accountId: f.card })).toThrow(/PERIOD_BEFORE_BUDGET_START/);
		expect(assignmentsForPeriod(f.db, july)).toEqual([]);
	});
});
