import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createTransaction, flagForReview, linkTransfer, softDelete } from '../ledger/transactions';
import { appendBalance } from '../sync/connections';
import { ledgerView } from './ledger';

describe('ledgerView', () => {
	it('filters, searches, paginates, and joins names', () => {
		const f = fixture();
		const t1 = createTransaction(f.db, { accountId: f.checking, externalId: 'a', postedDate: '2026-09-02', amount: -4500, payeeRaw: 'WHOLE FOODS 123', payee: 'Whole Foods', source: 'sync', splits: [{ categoryId: f.groceries, amount: -4500 }] });
		const t2 = createTransaction(f.db, { accountId: f.checking, externalId: 'b', postedDate: '2026-09-05', amount: -30000, payeeRaw: 'PAYMENT TO CARD', source: 'sync' });
		const t3 = createTransaction(f.db, { accountId: f.card, externalId: 'c', postedDate: '2026-09-05', amount: 30000, payeeRaw: 'PAYMENT THANK YOU', source: 'sync' });
		linkTransfer(f.db, t2, t3);
		flagForReview(f.db, t1, 'amount_changed');
		appendBalance(f.db, f.card, { asOf: '2026-09-08', current: 0, source: 'manual' }); // ledger says +30000 → drift

		const all = ledgerView(f.db, {});
		expect(all.total).toBe(3); expect(all.rows.map((r) => r.id)).toEqual([t3, t2, t1]);
		expect(all.rows[2]).toMatchObject({ payee: 'Whole Foods', accountName: 'Checking', needsReview: true, reviewReason: 'amount_changed', periodLabel: 'Sep 1–15, 2026' });
		expect(all.rows[2].splits[0]).toMatchObject({ categoryName: 'Groceries', amount: -4500 });
		expect(all.rows[1]).toMatchObject({ transferPeerId: t3, transferPeerAccountName: 'Sapphire' });
		expect(ledgerView(f.db, { accountId: f.card }).rows.map((r) => r.id)).toEqual([t3]);
		expect(ledgerView(f.db, { q: 'whole' }).rows.map((r) => r.id)).toEqual([t1]);
		expect(ledgerView(f.db, { categoryId: f.groceries }).rows.map((r) => r.id)).toEqual([t1]);
		expect(ledgerView(f.db, { from: '2026-09-03', to: '2026-09-05' }).total).toBe(2);
		expect(ledgerView(f.db, { review: true }).rows.map((r) => r.id)).toEqual([t1]);
		expect(ledgerView(f.db, { limit: 2, offset: 2 }).rows.map((r) => r.id)).toEqual([t1]);
		expect(all.drift).toEqual([{ accountId: f.card, accountName: 'Sapphire', drift: -30000 }]);
		expect(all.accounts.map((a) => a.name)).toEqual(['Checking', 'Savings', 'Sapphire']);
	});

	it('hides soft-deleted rows from total, rows, and search, and counts before pagination', () => {
		const f = fixture();
		createTransaction(f.db, { accountId: f.checking, externalId: 'a', postedDate: '2026-09-02', amount: -1000, payeeRaw: 'A', source: 'sync' });
		createTransaction(f.db, { accountId: f.checking, externalId: 'b', postedDate: '2026-09-03', amount: -1000, payeeRaw: 'B', source: 'sync' });
		createTransaction(f.db, { accountId: f.checking, externalId: 'c', postedDate: '2026-09-04', amount: -1000, payeeRaw: 'C', source: 'sync' });
		const t4 = createTransaction(f.db, { accountId: f.checking, externalId: 'd', postedDate: '2026-09-06', amount: -1000, payeeRaw: 'ZZZUNIQUE', source: 'sync' });
		softDelete(f.db, t4);

		const all = ledgerView(f.db, {});
		expect(all.total).toBe(3);
		expect(all.rows.map((r) => r.id)).not.toContain(t4);
		expect(ledgerView(f.db, { q: 'zzzunique' }).rows).toHaveLength(0);

		const paged = ledgerView(f.db, { limit: 2, offset: 0 });
		expect(paged.rows).toHaveLength(2);
		expect(paged.total).toBe(3);
	});
});
