import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { appendBalance, upsertAccount, updateAccount } from '../sync/connections';
import { createCategory } from '../ledger/categories';
import { createTransaction, linkTransfer } from '../ledger/transactions';
import { debtTrend } from './trend';

describe('debtTrend (P2 §4.4)', () => {
	it('carries balances forward, sums payments and interest per period, and blanks ledger columns before the first row', () => {
		const f = fixture();
		const loan = upsertAccount(f.db, f.conn, { externalId: 'loan', name: 'SoFi', type: 'loan' }).id;
		updateAccount(f.db, loan, { onBudget: false });
		const loanPay = createCategory(f.db, { groupId: f.groups.debt, name: 'SoFi', kind: 'debt_payment', accountId: loan });
		const interest = createCategory(f.db, { groupId: f.groups.bills, name: 'Interest', kind: 'interest' });
		appendBalance(f.db, f.card, { asOf: '2026-07-10', current: -80000, source: 'import' });
		appendBalance(f.db, f.card, { asOf: '2026-08-20', current: -70000, source: 'sync' });
		appendBalance(f.db, loan, { asOf: '2026-08-25', current: -500000, source: 'sync' });
		createTransaction(f.db, { accountId: f.checking, externalId: 'pay', postedDate: '2026-08-05', amount: 300000, payeeRaw: 'ACME', source: 'sync', splits: [{ categoryId: f.income, amount: 300000 }] });
		const out = createTransaction(f.db, { accountId: f.checking, externalId: 'p1', postedDate: '2026-08-18', amount: -10000, payeeRaw: 'CHASE', source: 'sync' });
		const inn = createTransaction(f.db, { accountId: f.card, externalId: 'p2', postedDate: '2026-08-18', amount: 10000, payeeRaw: 'PAYMENT', source: 'sync' });
		linkTransfer(f.db, out, inn);
		createTransaction(f.db, { accountId: f.checking, externalId: 'l1', postedDate: '2026-08-18', amount: -50000, payeeRaw: 'SOFI', source: 'sync', splits: [{ categoryId: loanPay, amount: -50000 }] });
		createTransaction(f.db, { accountId: f.card, externalId: 'i1', postedDate: '2026-08-19', amount: -1500, payeeRaw: 'INTEREST CHARGE', source: 'sync', splits: [{ categoryId: interest, amount: -1500 }] });

		const rows = debtTrend(f.db, { throughIso: '2026-09-08' });
		expect(rows.map((r) => [r.label, r.total, r.change, r.paid, r.interest, r.income])).toEqual([
			['Jul 1–15, 2026', 80000, null, null, null, null],
			['Jul 16–31, 2026', 80000, 0, null, null, null],
			['Aug 1–15, 2026', 80000, 0, 0, 0, 300000],
			['Aug 16–31, 2026', 570000, 490000, 60000, 1500, 0],
			['Sep 1–15, 2026', 570000, 0, 0, 0, 0]
		]);
		expect(rows[2].paidShare).toBe(0); expect(rows[3].paidShare).toBeNull();
	});
	it('is empty without debt snapshots and drops closed accounts after their close date', () => {
		const f = fixture();
		expect(debtTrend(f.db, { throughIso: '2026-09-08' })).toEqual([]);
		appendBalance(f.db, f.card, { asOf: '2026-08-20', current: -70000, source: 'sync' });
		updateAccount(f.db, f.card, { closedAt: '2026-09-01' });
		const rows = debtTrend(f.db, { throughIso: '2026-09-08' });
		expect(rows.map((r) => r.total)).toEqual([70000, 0]);
	});
});
