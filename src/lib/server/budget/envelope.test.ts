import { describe, it, expect } from 'vitest';
import { computeBudget, type BudgetInput, type EnvSplit } from './envelope';

// Fixed ids
const CHECKING = 1, SAVINGS = 2, CARD = 3, LOAN = 4;
const INCOME = 10, TRANSFER = 11, RECON = 12;
const GROCERIES = 20, RENT = 21, INTEREST = 22;
const CARD_ENV = 30, LOAN_ENV = 31, SAVINGS_ENV = 32;
const P1 = 1, P2 = 2, P3 = 3;

function base(): BudgetInput {
	return {
		accounts: [
			{ id: CHECKING, type: 'checking', onBudget: true },
			{ id: SAVINGS, type: 'savings', onBudget: true },
			{ id: CARD, type: 'credit', onBudget: true },
			{ id: LOAN, type: 'loan', onBudget: false }
		],
		categories: [
			{ id: INCOME, kind: 'income', accountId: null },
			{ id: TRANSFER, kind: 'transfer', accountId: null },
			{ id: RECON, kind: 'reconciliation', accountId: null },
			{ id: GROCERIES, kind: 'spending', accountId: null },
			{ id: RENT, kind: 'bill', accountId: null },
			{ id: INTEREST, kind: 'interest', accountId: null },
			{ id: CARD_ENV, kind: 'debt_payment', accountId: CARD },
			{ id: LOAN_ENV, kind: 'debt_payment', accountId: LOAN },
			{ id: SAVINGS_ENV, kind: 'savings', accountId: null }
		],
		periods: [
			{ id: P1, startDate: '2026-01-01' },
			{ id: P2, startDate: '2026-01-16' },
			{ id: P3, startDate: '2026-02-01' }
		],
		splits: [],
		assignments: [],
		balances: []
	};
}

let nextTx = 1000;
function split(p: Partial<EnvSplit> & Pick<EnvSplit, 'accountId' | 'periodId' | 'categoryId' | 'amount'>): EnvSplit {
	return { transactionId: nextTx++, transferPeerAccountId: null, source: 'sync', ...p };
}
/** Opening balance on a cash account. */
function opening(accountId: number, periodId: number, amount: number): EnvSplit {
	return split({ accountId, periodId, categoryId: RECON, amount, source: 'opening' });
}
/** Both halves of a transfer from `from` to `to` of `amount` (positive). */
function transfer(from: number, to: number, periodId: number, amount: number): EnvSplit[] {
	return [
		split({ accountId: from, periodId, categoryId: TRANSFER, amount: -amount, transferPeerAccountId: to }),
		split({ accountId: to, periodId, categoryId: TRANSFER, amount, transferPeerAccountId: from })
	];
}
/** Balances derived from splits: a reconciled ledger. */
function reconcile(input: BudgetInput): BudgetInput {
	const totals = new Map<number, number>();
	for (const s of input.splits) totals.set(s.accountId, (totals.get(s.accountId) ?? 0) + s.amount);
	return { ...input, balances: input.accounts.map((a) => ({ accountId: a.id, current: totals.get(a.id) ?? 0 })) };
}
function avail(r: ReturnType<typeof computeBudget>, p: number, c: number) {
	return r.byPeriod.get(p)!.get(c)!.available;
}

describe('§7 hand-built scenarios', () => {
	it('$80 on the card with $50 available: credit overspend never reaches RTA', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: GROCERIES, assigned: 5000 });
		const before = computeBudget(reconcile(input), P1);
		expect(before.readyToAssign).toBe(95000);

		input.splits.push(split({ accountId: CARD, periodId: P1, categoryId: GROCERIES, amount: -8000 }));
		const r = computeBudget(reconcile(input), P1);
		expect(avail(r, P1, GROCERIES)).toBe(-3000);
		expect(r.byPeriod.get(P1)!.get(GROCERIES)!.creditOverspend).toBe(3000);
		expect(r.byPeriod.get(P1)!.get(GROCERIES)!.cashOverspend).toBe(0);
		expect(avail(r, P1, CARD_ENV)).toBe(5000);   // only the covered $50 moved
		expect(r.readyToAssign).toBe(95000);         // unchanged: no cash moved
		expect(r.readyToAssignFromFlows).toBe(95000);
		expect(r.underfunded.get(CARD)).toBe(3000);  // card owes 80, envelope holds 50
	});

	it('cash overspend leaves RTA immediately and is zeroed at rollover', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: GROCERIES, assigned: 5000 });
		input.splits.push(split({ accountId: CHECKING, periodId: P1, categoryId: GROCERIES, amount: -8000 }));
		const r1 = computeBudget(reconcile(input), P1);
		expect(avail(r1, P1, GROCERIES)).toBe(-3000);
		expect(r1.byPeriod.get(P1)!.get(GROCERIES)!.cashOverspend).toBe(3000);
		expect(r1.readyToAssign).toBe(92000);
		expect(r1.readyToAssignFromFlows).toBe(92000);
		const r2 = computeBudget(reconcile(input), P2);
		expect(r2.byPeriod.get(P2)!.get(GROCERIES)!.carried).toBe(0);
		expect(r2.readyToAssign).toBe(92000);
		expect(r2.readyToAssignFromFlows).toBe(92000);
	});

	it('cash and card overspend in the same period charge card spending first', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: GROCERIES, assigned: 5000 });
		input.splits.push(split({ accountId: CHECKING, periodId: P1, categoryId: GROCERIES, amount: -4000 }));
		input.splits.push(split({ accountId: CARD, periodId: P1, categoryId: GROCERIES, amount: -3000 }));
		const r = computeBudget(reconcile(input), P1);
		const g = r.byPeriod.get(P1)!.get(GROCERIES)!;
		expect(g.available).toBe(-2000);
		expect(g.creditOverspend).toBe(2000);
		expect(g.cashOverspend).toBe(0);
		expect(avail(r, P1, CARD_ENV)).toBe(1000); // 3000 spent, 2000 uncovered
		expect(r.readyToAssign).toBe(r.readyToAssignFromFlows);
	});

	it('paying the card above its envelope drives the envelope negative and RTA down', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: CARD_ENV, assigned: 5000 });
		input.splits.push(...transfer(CHECKING, CARD, P1, 10000));
		const r = computeBudget(reconcile(input), P1);
		expect(avail(r, P1, CARD_ENV)).toBe(-5000);
		expect(r.readyToAssign).toBe(90000);          // cash 90000; the negative envelope adds nothing to positive available
		expect(r.readyToAssignFromFlows).toBe(90000); // 100000 − 5000 assigned − 5000 negative card envelope
		const r2 = computeBudget(reconcile(input), P2);
		expect(r2.byPeriod.get(P2)!.get(CARD_ENV)!.carried).toBe(-5000); // no floor
	});

	it('a loan payment is spending-like and leaves the budget through cash', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: LOAN_ENV, assigned: 87829 });
		input.splits.push(split({ accountId: CHECKING, periodId: P1, categoryId: LOAN_ENV, amount: -87829, transferPeerAccountId: LOAN }));
		const r = computeBudget(reconcile(input), P1);
		expect(avail(r, P1, LOAN_ENV)).toBe(0);
		expect(r.readyToAssign).toBe(100000 - 87829);
		expect(r.readyToAssign).toBe(r.readyToAssignFromFlows);
	});

	it('a late transaction reassigned into a past period changes every carry after it', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: GROCERIES, assigned: 5000 });
		const r0 = computeBudget(reconcile(input), P3);
		expect(r0.byPeriod.get(P3)!.get(GROCERIES)!.carried).toBe(5000);
		input.splits.push(split({ accountId: CHECKING, periodId: P1, categoryId: GROCERIES, amount: -2000 }));
		const r1 = computeBudget(reconcile(input), P3);
		expect(r1.byPeriod.get(P2)!.get(GROCERIES)!.carried).toBe(3000);
		expect(r1.byPeriod.get(P3)!.get(GROCERIES)!.carried).toBe(3000);
	});

	it('a refund on the card in a net-refund period does not create negative overspend', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.splits.push(split({ accountId: CARD, periodId: P1, categoryId: GROCERIES, amount: 2500 }));
		const r = computeBudget(reconcile(input), P1);
		const g = r.byPeriod.get(P1)!.get(GROCERIES)!;
		expect(g.creditOverspend).toBe(0);
		expect(g.available).toBe(2500);
		expect(avail(r, P1, CARD_ENV)).toBe(-2500); // the card owes less; money leaves the envelope
		expect(r.readyToAssign).toBe(r.readyToAssignFromFlows);
	});

	it('future assignments reduce current RTA', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P2, categoryId: RENT, assigned: 20000 });
		const r = computeBudget(reconcile(input), P1);
		expect(r.readyToAssign).toBe(80000);
		expect(r.readyToAssignFromFlows).toBe(80000);
	});

	it('a period with no assignments and income only', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 0));
		input.splits.push(split({ accountId: CHECKING, periodId: P1, categoryId: INCOME, amount: 319200 }));
		const r = computeBudget(reconcile(input), P1);
		expect(r.readyToAssign).toBe(319200);
		expect(r.readyToAssignFromFlows).toBe(319200);
	});

	it('interest charged on the card moves money from the Interest envelope into the card envelope', () => {
		const input = base();
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: INTEREST, assigned: 3000 });
		input.splits.push(split({ accountId: CARD, periodId: P1, categoryId: INTEREST, amount: -2600 }));
		const r = computeBudget(reconcile(input), P1);
		expect(avail(r, P1, INTEREST)).toBe(400);
		expect(avail(r, P1, CARD_ENV)).toBe(2600);
		expect(r.readyToAssign).toBe(97000);
		expect(r.readyToAssign).toBe(r.readyToAssignFromFlows);
	});

	it('credit overspend across two cards is apportioned by purchases with largest-remainder rounding', () => {
		const CARD2 = 5, CARD2_ENV = 33;
		const input = base();
		input.accounts.push({ id: CARD2, type: 'credit', onBudget: true });
		input.categories.push({ id: CARD2_ENV, kind: 'debt_payment', accountId: CARD2 });
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: GROCERIES, assigned: 4999 });
		input.splits.push(split({ accountId: CARD, periodId: P1, categoryId: GROCERIES, amount: -3333 }));
		input.splits.push(split({ accountId: CARD2, periodId: P1, categoryId: GROCERIES, amount: -6667 }));
		const r = computeBudget(reconcile(input), P1);
		const g = r.byPeriod.get(P1)!.get(GROCERIES)!;
		expect(g.available).toBe(-5001);
		expect(g.creditOverspend).toBe(5001);
		expect(g.cashOverspend).toBe(0);
		// exact shares 1666.83 and 3334.17: floors 1666 + 3334 = 5000, the remaining cent goes to the larger fraction (card 1)
		expect(avail(r, P1, CARD_ENV)).toBe(3333 - 1667);   // 1666
		expect(avail(r, P1, CARD2_ENV)).toBe(6667 - 3334);  // 3333
		expect(r.underfunded.get(CARD)).toBe(1667);
		expect(r.underfunded.get(CARD2)).toBe(3334);
		expect(r.readyToAssign).toBe(95001);
		expect(r.readyToAssignFromFlows).toBe(95001);
	});
	it('a card-to-card balance transfer moves the receiving card\'s envelope money to the paying card (P2 §4.5)', () => {
		const CARD2 = 5, CARD2_ENV = 33;
		const input = base();
		input.accounts.push({ id: CARD2, type: 'credit', onBudget: true });
		input.categories.push({ id: CARD2_ENV, kind: 'debt_payment', accountId: CARD2 });
		input.splits.push(opening(CHECKING, P1, 100000));
		input.assignments.push({ periodId: P1, categoryId: GROCERIES, assigned: 20000 });
		input.splits.push(split({ accountId: CARD, periodId: P1, categoryId: GROCERIES, amount: -20000 }));   // CARD owes 200, its envelope holds 200
		input.splits.push(...transfer(CARD2, CARD, P1, 15000));                                              // CARD2 pays 150 of it
		const r = computeBudget(reconcile(input), P1);
		expect(avail(r, P1, CARD_ENV)).toBe(5000);
		expect(avail(r, P1, CARD2_ENV)).toBe(15000);
		expect(r.cardBalanceOwed.get(CARD)).toBe(5000);
		expect(r.cardBalanceOwed.get(CARD2)).toBe(15000);
		expect(r.underfunded.get(CARD)).toBe(0);
		expect(r.underfunded.get(CARD2)).toBe(0);
		expect(r.readyToAssign).toBe(80000);
		expect(r.readyToAssignFromFlows).toBe(80000);
	});
});
