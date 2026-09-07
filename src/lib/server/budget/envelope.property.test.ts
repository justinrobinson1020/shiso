import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeBudget, type BudgetInput, type EnvSplit } from './envelope';

const CHECKING = 1, SAVINGS = 2, CARD = 3, CARD2 = 5, LOAN = 4;
const INCOME = 10, TRANSFER = 11, RECON = 12;
const GROCERIES = 20, RENT = 21, INTEREST = 22, FEES = 23;
const CARD_ENV = 30, CARD2_ENV = 33, LOAN_ENV = 31, SAVINGS_ENV = 32;
const ENVELOPES = [GROCERIES, RENT, INTEREST, FEES, CARD_ENV, CARD2_ENV, LOAN_ENV, SAVINGS_ENV];
const SPENDING = [GROCERIES, RENT, INTEREST, FEES];

function skeleton(nPeriods: number): BudgetInput {
	return {
		accounts: [
			{ id: CHECKING, type: 'checking', onBudget: true },
			{ id: SAVINGS, type: 'savings', onBudget: true },
			{ id: CARD, type: 'credit', onBudget: true },
			{ id: CARD2, type: 'credit', onBudget: true },
			{ id: LOAN, type: 'loan', onBudget: false }
		],
		categories: [
			{ id: INCOME, kind: 'income', accountId: null },
			{ id: TRANSFER, kind: 'transfer', accountId: null },
			{ id: RECON, kind: 'reconciliation', accountId: null },
			{ id: GROCERIES, kind: 'spending', accountId: null },
			{ id: RENT, kind: 'bill', accountId: null },
			{ id: INTEREST, kind: 'interest', accountId: null },
			{ id: FEES, kind: 'fee', accountId: null },
			{ id: CARD_ENV, kind: 'debt_payment', accountId: CARD },
			{ id: CARD2_ENV, kind: 'debt_payment', accountId: CARD2 },
			{ id: LOAN_ENV, kind: 'debt_payment', accountId: LOAN },
			{ id: SAVINGS_ENV, kind: 'savings', accountId: null }
		],
		periods: Array.from({ length: nPeriods }, (_, i) => ({ id: i + 1, startDate: `2026-${String(Math.floor(i / 2) + 1).padStart(2, '0')}-${i % 2 === 0 ? '01' : '16'}` })),
		splits: [], assignments: [], balances: []
	};
}

type Event =
	| { t: 'income'; amount: number }
	| { t: 'purchase'; account: number; category: number; amount: number }
	| { t: 'refund'; account: number; category: number; amount: number }
	| { t: 'payment'; card: number; amount: number }
	| { t: 'loan'; amount: number }
	| { t: 'save'; amount: number }
	| { t: 'assign'; category: number; amount: number }
	| { t: 'adjust'; amount: number };

const cents = (max: number) => fc.integer({ min: 1, max });
const event: fc.Arbitrary<Event> = fc.oneof(
	fc.record({ t: fc.constant('income' as const), amount: cents(400000) }),
	fc.record({ t: fc.constant('purchase' as const), account: fc.constantFrom(CHECKING, CARD, CARD2), category: fc.constantFrom(...SPENDING), amount: cents(30000) }),
	fc.record({ t: fc.constant('refund' as const), account: fc.constantFrom(CHECKING, CARD, CARD2), category: fc.constantFrom(...SPENDING), amount: cents(5000) }),
	fc.record({ t: fc.constant('payment' as const), card: fc.constantFrom(CARD, CARD2), amount: cents(50000) }),
	fc.record({ t: fc.constant('loan' as const), amount: cents(90000) }),
	fc.record({ t: fc.constant('save' as const), amount: cents(60000) }),
	fc.record({ t: fc.constant('assign' as const), category: fc.constantFrom(...ENVELOPES), amount: fc.integer({ min: -20000, max: 60000 }) }),
	fc.record({ t: fc.constant('adjust' as const), amount: fc.integer({ min: -3000, max: 3000 }) })
);

const ledger = fc
	.tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 800000 }))
	.chain(([n, opening]) =>
		fc.array(fc.array(event, { minLength: 0, maxLength: 12 }), { minLength: n, maxLength: n })
			.map((perPeriod) => build(n, opening, perPeriod))
	);

function build(n: number, opening: number, perPeriod: Event[][]): BudgetInput {
	const input = skeleton(n);
	let tx = 1;
	const push = (s: Omit<EnvSplit, 'transactionId'>) => input.splits.push({ transactionId: tx++, ...s });
	push({ accountId: CHECKING, periodId: 1, categoryId: RECON, amount: opening, transferPeerAccountId: null, source: 'opening' });
	perPeriod.forEach((events, i) => {
		const p = i + 1;
		for (const e of events) {
			switch (e.t) {
				case 'income': push({ accountId: CHECKING, periodId: p, categoryId: INCOME, amount: e.amount, transferPeerAccountId: null, source: 'sync' }); break;
				case 'purchase': push({ accountId: e.account, periodId: p, categoryId: e.category, amount: -e.amount, transferPeerAccountId: null, source: 'sync' }); break;
				case 'refund': push({ accountId: e.account, periodId: p, categoryId: e.category, amount: e.amount, transferPeerAccountId: null, source: 'sync' }); break;
				case 'payment':
					push({ accountId: CHECKING, periodId: p, categoryId: TRANSFER, amount: -e.amount, transferPeerAccountId: e.card, source: 'sync' });
					push({ accountId: e.card, periodId: p, categoryId: TRANSFER, amount: e.amount, transferPeerAccountId: CHECKING, source: 'sync' });
					break;
				case 'loan': push({ accountId: CHECKING, periodId: p, categoryId: LOAN_ENV, amount: -e.amount, transferPeerAccountId: LOAN, source: 'sync' }); break;
				case 'save':
					push({ accountId: CHECKING, periodId: p, categoryId: TRANSFER, amount: -e.amount, transferPeerAccountId: SAVINGS, source: 'sync' });
					push({ accountId: SAVINGS, periodId: p, categoryId: TRANSFER, amount: e.amount, transferPeerAccountId: CHECKING, source: 'sync' });
					break;
				case 'assign': input.assignments.push({ periodId: p, categoryId: e.category, assigned: e.amount }); break;
				case 'adjust': push({ accountId: CHECKING, periodId: p, categoryId: RECON, amount: e.amount, transferPeerAccountId: null, source: 'adjustment' }); break;
			}
		}
	});
	return input;
}

/** Balances as of the end of period P, i.e. a reconciled ledger viewed from P. */
function balancesThrough(input: BudgetInput, P: number): BudgetInput['balances'] {
	const totals = new Map<number, number>();
	for (const s of input.splits) if (s.periodId <= P) totals.set(s.accountId, (totals.get(s.accountId) ?? 0) + s.amount);
	return input.accounts.map((a) => ({ accountId: a.id, current: totals.get(a.id) ?? 0 }));
}

describe('§7.5 conservation', () => {
	it('ready-to-assign from balances equals ready-to-assign from flows for every period of any reconciled ledger', () => {
		fc.assert(
			fc.property(ledger, (input) => {
				for (const p of input.periods) {
					const r = computeBudget({ ...input, balances: balancesThrough(input, p.id) }, p.id);
					expect(r.readyToAssign).toBe(r.readyToAssignFromFlows);
				}
			}),
			{ numRuns: 500 }
		);
	});
});
