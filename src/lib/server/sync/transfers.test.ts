import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, connections } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { createTransaction, getTransaction, setSplits } from '../ledger/transactions';
import { detectTransfers } from './transfers';

let db: Db; let chk: number; let card: number; let loan: number; let savings: number;
const mk = (accountId: number, ext: string, amount: number, postedDate: string, payeeRaw: string) =>
	createTransaction(db, { accountId, externalId: ext, postedDate, amount, payeeRaw, source: 'sync' });

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	const add = (ext: string, type: 'checking' | 'savings' | 'credit' | 'loan', onBudget: boolean, isDebt: boolean) =>
		db.insert(accounts).values({ connectionId: c, externalId: ext, name: ext, type, onBudget, isDebt }).returning({ id: accounts.id }).get().id;
	chk = add('chk', 'checking', true, false);
	savings = add('sav', 'savings', true, false);
	card = add('card', 'credit', true, true);
	loan = add('loan', 'loan', false, true);
});

describe('detectTransfers', () => {
	it('links a card payment pair and leaves both as transfer kind', () => {
		const a = mk(chk, 'a', -25000, '2026-03-10', 'CHASE CREDIT CRD AUTOPAY');
		const b = mk(card, 'b', 25000, '2026-03-11', 'Payment Thank You');
		const r = detectTransfers(db, [a, b], { windowDays: 4 });
		expect(r).toEqual({ linked: 1, flagged: 0, categorized: 0 });
		expect(getTransaction(db, a).transferPeerId).toBe(b);
		expect(getTransaction(db, a).splits[0].categoryId).toBe(systemCategoryId(db, 'transfer'));
	});
	it('prefers the payment-looking counterpart over a same-amount refund', () => {
		const pay = mk(chk, 'p', -10000, '2026-03-10', 'ONLINE PAYMENT TO CARD');
		const refund = mk(card, 'r', 10000, '2026-03-09', 'REFUND ACME STORE');
		const recv = mk(card, 'q', 10000, '2026-03-11', 'PAYMENT RECEIVED');
		detectTransfers(db, [pay], { windowDays: 4 });
		expect(getTransaction(db, pay).transferPeerId).toBe(recv);
		expect(getTransaction(db, refund).transferPeerId).toBeNull();
	});
	it('flags an unresolvable tie instead of guessing', () => {
		const pay = mk(chk, 'p', -10000, '2026-03-10', 'XFER');
		mk(card, 'x', 10000, '2026-03-10', 'PAYMENT');
		mk(card, 'y', 10000, '2026-03-11', 'PAYMENT');
		const r = detectTransfers(db, [pay], { windowDays: 4 });
		expect(r.flagged).toBe(1);
		expect(getTransaction(db, pay).reviewReason).toBe('transfer_ambiguous');
		expect(getTransaction(db, pay).transferPeerId).toBeNull();
	});
	it('categorises the near side of an off-budget transfer to the far account\'s payment category', () => {
		const loanEnv = createCategory(db, { groupId: createGroup(db, 'Debt'), name: 'SoFi', kind: 'debt_payment', accountId: loan });
		const near = mk(chk, 'n', -87829, '2026-03-21', 'SOFI LOAN PMT');
		const far = mk(loan, 'f', 87829, '2026-03-21', 'PAYMENT');
		const r = detectTransfers(db, [near], { windowDays: 4 });
		expect(r.categorized).toBe(1);
		expect(getTransaction(db, near).transferPeerId).toBe(far);
		expect(getTransaction(db, near).splits[0].categoryId).toBe(loanEnv);
		expect(getTransaction(db, far).splits[0].categoryId).toBe(systemCategoryId(db, 'transfer'));
	});
	it('flags an off-budget transfer whose far account has no payment category', () => {
		const near = mk(chk, 'n', -500, '2026-03-21', 'LOAN PMT');
		mk(loan, 'f', 500, '2026-03-21', 'PAYMENT');
		const r = detectTransfers(db, [near], { windowDays: 4 });
		expect(r.flagged).toBe(1);
		expect(getTransaction(db, near).reviewReason).toBe('transfer_off_budget_uncategorized');
	});
	it('keeps a category a rule already gave the near side when the off-budget far account has no payment category', () => {
		const wedding = createCategory(db, { groupId: createGroup(db, 'Savings'), name: 'Wedding', kind: 'savings' });
		const near = mk(chk, 'n', -60000, '2026-03-21', 'PAYMENT TO AMEX');
		setSplits(db, near, [{ categoryId: wedding, amount: -60000 }]);
		const far = mk(loan, 'f', 60000, '2026-03-21', 'TRANSFER FROM NASA');
		const r = detectTransfers(db, [near], { windowDays: 4 });
		expect(r).toEqual({ linked: 1, flagged: 0, categorized: 1 });
		expect(getTransaction(db, near).transferPeerId).toBe(far);
		expect(getTransaction(db, near).splits.map((s) => s.categoryId)).toEqual([wedding]);
		expect(getTransaction(db, near).needsReview).toBe(false);
		expect(getTransaction(db, far).splits[0].categoryId).toBe(systemCategoryId(db, 'transfer'));
	});
	it('ignores pairs outside the window and pairs with no cash side', () => {
		const a = mk(chk, 'a', -100, '2026-03-01', 'X');
		mk(savings, 'b', 100, '2026-03-20', 'X');
		const c = mk(card, 'c', -300, '2026-03-05', 'BAL XFER');
		mk(loan, 'd', 300, '2026-03-05', 'BAL XFER');
		const r = detectTransfers(db, [a, c], { windowDays: 4 });
		expect(r.linked).toBe(0);
		expect(getTransaction(db, c).transferPeerId).toBeNull();
	});
});
