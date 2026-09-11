import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { fixture } from '../test/fixture';
import { appendBalance, appendTermsIfChanged } from '../sync/connections';
import { createBill } from '../bills/bills';
import { assignmentsForPeriod } from '../ledger/assignments';
import { periodIdForDate } from '../budget/periods';
import { plannedExtras, promoBalances } from '../db/schema';
import { setPlannedExtra, plannedExtrasForPeriod, fundShortfall, debtMinimum, createPromo, updatePromo, closePromo, openPromos } from './plan';

describe('planned extras', () => {
	it('upserts, deletes on zero, and rejects non-debt accounts and negatives', () => {
		const f = fixture(); const p = periodIdForDate(f.db, '2026-09-08');
		setPlannedExtra(f.db, { periodId: p, accountId: f.card, extraAmount: 10000 });
		setPlannedExtra(f.db, { periodId: p, accountId: f.card, extraAmount: 12000 });
		expect(plannedExtrasForPeriod(f.db, p).get(f.card)).toBe(12000);
		expect(f.db.select().from(plannedExtras).all()).toHaveLength(1);
		setPlannedExtra(f.db, { periodId: p, accountId: f.card, extraAmount: 0 });
		expect(f.db.select().from(plannedExtras).all()).toHaveLength(0);
		expect(() => setPlannedExtra(f.db, { periodId: p, accountId: f.checking, extraAmount: 1 })).toThrow('NOT_DEBT_ACCOUNT');
		expect(() => setPlannedExtra(f.db, { periodId: p, accountId: f.card, extraAmount: -1 })).toThrow('EXTRA_NEGATIVE');
	});
});

describe('debtMinimum', () => {
	it('prefers terms, then the linked bill, then null', () => {
		const f = fixture();
		expect(debtMinimum(f.db, f.card)).toBeNull();
		createBill(f.db, { name: 'Sapphire', categoryId: f.cardPay, payFromAccountId: f.checking, expectedAmount: 3500, cadence: 'monthly', dueDay: 25, linkedDebtAccountId: f.card });
		expect(debtMinimum(f.db, f.card)).toBe(3500);
		appendTermsIfChanged(f.db, f.card, { asOf: '2026-09-01', minPayment: 4200, source: 'manual' });
		expect(debtMinimum(f.db, f.card)).toBe(4200);
	});
});

describe('fundShortfall (P2 §4.2)', () => {
	it('assigns the gap between the planned payment and the envelope, and is idempotent', () => {
		const f = fixture(); const p = periodIdForDate(f.db, '2026-09-08');
		appendBalance(f.db, f.checking, { asOf: '2026-09-07', current: 250000, source: 'manual' });
		appendBalance(f.db, f.card, { asOf: '2026-09-07', current: -80000, source: 'manual' });
		createBill(f.db, { name: 'Sapphire', categoryId: f.cardPay, payFromAccountId: f.checking, expectedAmount: 3500, cadence: 'monthly', dueDay: 25, linkedDebtAccountId: f.card });
		setPlannedExtra(f.db, { periodId: p, accountId: f.card, extraAmount: 10000 });
		const r = fundShortfall(f.db, { periodId: p, accountId: f.card });
		expect(r).toEqual({ categoryId: f.cardPay, shortfall: 13500, assigned: 13500 });
		expect(assignmentsForPeriod(f.db, p)).toEqual([{ categoryId: f.cardPay, assigned: 13500 }]);
		expect(fundShortfall(f.db, { periodId: p, accountId: f.card })).toEqual({ categoryId: f.cardPay, shortfall: 0, assigned: 13500 });
		expect(() => fundShortfall(f.db, { periodId: p, accountId: f.checking })).toThrow('NOT_DEBT_ACCOUNT');
	});
});

describe('promo balances', () => {
	it('creates with remaining defaulting to original, updates within range, and closes', () => {
		const f = fixture();
		const id = createPromo(f.db, { accountId: f.card, description: 'Balance transfer', originalAmount: 500000, expiresOn: '2027-06-30' });
		expect(openPromos(f.db)[0]).toMatchObject({ id, remainingAmount: 500000, aprBps: 0, closedAt: null });
		updatePromo(f.db, id, { remainingAmount: 420000, aprBps: 299 });
		expect(f.db.select().from(promoBalances).where(eq(promoBalances.id, id)).get()).toMatchObject({ remainingAmount: 420000, aprBps: 299 });
		expect(() => updatePromo(f.db, id, { remainingAmount: 500001 })).toThrow('PROMO_REMAINING_OUT_OF_RANGE');
		expect(() => createPromo(f.db, { accountId: f.checking, description: 'x', originalAmount: 100, expiresOn: '2027-01-01' })).toThrow('NOT_DEBT_ACCOUNT');
		expect(() => createPromo(f.db, { accountId: f.card, description: 'x', originalAmount: 0, expiresOn: '2027-01-01' })).toThrow('PROMO_AMOUNT_NOT_POSITIVE');
		updatePromo(f.db, id, { remainingAmount: 0 });
		expect(openPromos(f.db)).toHaveLength(0);
		updatePromo(f.db, id, { remainingAmount: 100 });
		expect(openPromos(f.db)).toHaveLength(1);
		closePromo(f.db, id);
		expect(openPromos(f.db)).toHaveLength(0);
	});
});
