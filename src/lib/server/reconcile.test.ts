import { describe, it, expect, beforeEach } from 'vitest';
import { type Db } from './db';
import { openMemoryDatabase } from './test/memory-db';
import { accounts, connections } from './db/schema';
import { seedDefaultCategories } from './ledger/categories';
import { ensurePeriods } from './budget/periods';
import { createTransaction, getTransaction, softDelete } from './ledger/transactions';
import { appendBalance } from './sync/connections';
import { setSetting } from './settings';
import { driftForAccount, driftReport, createAdjustment, observeDrift, driftSettled, PENDING_CONVENTION_KEY } from './reconcile';

let db: Db; let chk: number; let card: number;
beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	chk = db.insert(accounts).values({ connectionId: c, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	card = db.insert(accounts).values({ connectionId: c, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
});

describe('drift', () => {
	it('excludes pending on cash accounts and includes it on cards by default', () => {
		createTransaction(db, { accountId: chk, externalId: 'a', postedDate: '2026-09-01', amount: -1000, payeeRaw: 'A', source: 'sync' });
		createTransaction(db, { accountId: chk, externalId: 'p', postedDate: '2026-09-02', amount: -500, payeeRaw: 'P', pending: true, source: 'sync' });
		appendBalance(db, chk, { asOf: '2026-09-02', current: -1000, source: 'sync' });
		expect(driftForAccount(db, chk)).toEqual({ accountId: chk, providerBalance: -1000, ledgerBalance: -1000, drift: 0, convention: 'exclude_pending' });
		createTransaction(db, { accountId: card, externalId: 'cp', postedDate: '2026-09-02', amount: -700, payeeRaw: 'P', pending: true, source: 'sync' });
		appendBalance(db, card, { asOf: '2026-09-02', current: -700, source: 'sync' });
		expect(driftForAccount(db, card).drift).toBe(0);
	});
	it('honours a per-account override and reports null with no balance row', () => {
		createTransaction(db, { accountId: chk, externalId: 'p', postedDate: '2026-09-02', amount: -500, payeeRaw: 'P', pending: true, source: 'sync' });
		expect(driftForAccount(db, chk).drift).toBeNull();
		appendBalance(db, chk, { asOf: '2026-09-02', current: -500, source: 'sync' });
		expect(driftForAccount(db, chk).drift).toBe(-500);
		setSetting(db, PENDING_CONVENTION_KEY, { [chk]: 'include_pending' });
		expect(driftForAccount(db, chk)).toMatchObject({ drift: 0, convention: 'include_pending' });
		expect(driftReport(db).length).toBe(2);
	});
	it('creates a processed adjustment that closes the drift', () => {
		appendBalance(db, chk, { asOf: '2026-09-02', current: 12345, source: 'sync' });
		const d = driftForAccount(db, chk);
		const id = createAdjustment(db, chk, d.drift!, '2026-09-02');
		const t = getTransaction(db, id);
		expect(t.source).toBe('adjustment');
		expect(t.processedAt).not.toBeNull();
		expect(driftForAccount(db, chk).drift).toBe(0);
	});
});

// A provider's balance can land a sync or two before the transactions that explain it (a paycheck on 2026-10-19 did:
// balance at 18:55, rows at 07:00 next day). An adjustment made in that window double-counts once they arrive, so a
// synced account's drift is only offered for adjustment after it has survived two full syncs unchanged.
describe('drift settling', () => {
	let plaidChk: number; let plaidConn: number;
	beforeEach(() => {
		plaidConn = db.insert(connections).values({ provider: 'plaid', institutionName: 'Bank' }).returning({ id: connections.id }).get().id;
		plaidChk = db.insert(accounts).values({ connectionId: plaidConn, externalId: 'pk', name: 'Synced Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
		appendBalance(db, plaidChk, { asOf: '2026-10-19', current: 350471, source: 'sync' });   // balance ahead of the feed
	});

	it('is not settled after one full sync has seen the drift', () => {
		observeDrift(db, plaidConn, '2026-10-19T18:55:00Z');
		expect(driftSettled(db, plaidChk)).toBe(false);
	});
	it('is settled once a second full sync sees the same drift', () => {
		observeDrift(db, plaidConn, '2026-10-19T18:55:00Z');
		observeDrift(db, plaidConn, '2026-10-20T07:00:00Z');
		expect(driftSettled(db, plaidChk)).toBe(true);
	});
	it('restarts the count when the late transactions arrive and change the drift', () => {
		observeDrift(db, plaidConn, '2026-10-19T18:55:00Z');
		createTransaction(db, { accountId: plaidChk, externalId: 'pay', postedDate: '2026-10-19', amount: 319623, payeeRaw: 'Salary', source: 'sync' });
		observeDrift(db, plaidConn, '2026-10-20T07:00:00Z');
		expect(driftSettled(db, plaidChk)).toBe(false);
		observeDrift(db, plaidConn, '2026-10-21T07:00:00Z');
		expect(driftSettled(db, plaidChk)).toBe(true);
	});
	it('is not settled when the drift has moved since the last full sync (a balance refresh in between)', () => {
		observeDrift(db, plaidConn, '2026-10-19T07:00:00Z');
		observeDrift(db, plaidConn, '2026-10-20T07:00:00Z');
		appendBalance(db, plaidChk, { asOf: '2026-10-20', current: 340000, source: 'sync' });
		expect(driftSettled(db, plaidChk)).toBe(false);
	});
	it('forgets a drift that closes, so a later identical drift has to settle again', () => {
		observeDrift(db, plaidConn, '2026-10-19T07:00:00Z');
		observeDrift(db, plaidConn, '2026-10-20T07:00:00Z');
		const pay = createTransaction(db, { accountId: plaidChk, externalId: 'pay', postedDate: '2026-10-19', amount: 350471, payeeRaw: 'Salary', source: 'sync' });
		observeDrift(db, plaidConn, '2026-10-21T07:00:00Z');
		softDelete(db, pay);
		observeDrift(db, plaidConn, '2026-10-22T07:00:00Z');
		expect(driftSettled(db, plaidChk)).toBe(false);
	});
	it('treats a manual account as settled at once: its drift is a balance the user typed, not feed lag', () => {
		appendBalance(db, chk, { asOf: '2026-10-19', current: 5000, source: 'manual' });
		expect(driftSettled(db, chk)).toBe(true);
	});
});
