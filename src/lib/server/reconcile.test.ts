import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from './db';
import { accounts, connections } from './db/schema';
import { seedDefaultCategories } from './ledger/categories';
import { ensurePeriods } from './budget/periods';
import { createTransaction, getTransaction } from './ledger/transactions';
import { appendBalance } from './sync/connections';
import { setSetting } from './settings';
import { driftForAccount, driftReport, createAdjustment, PENDING_CONVENTION_KEY } from './reconcile';

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
