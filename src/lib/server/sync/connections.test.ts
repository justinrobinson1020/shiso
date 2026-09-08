import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../db';
import { accountBalances, accountTerms, accounts, connections } from '../db/schema';
import {
	createConnection, getCredential, setConnectionStatus, recordConnectionSuccess, listActiveConnections,
	upsertAccount, appendBalance, appendTermsIfChanged, latestTerms, latestBalance
} from './connections';
import { eq } from 'drizzle-orm';

const KEY = 'k'.repeat(44);
let db: Db;
beforeEach(() => { db = openMemoryDatabase().db; });

describe('connections', () => {
	it('stores the credential encrypted and reads it back', () => {
		const id = createConnection(db, { provider: 'plaid', institutionName: 'Chase', externalItemId: 'item-1', credential: 'access-1', appKey: KEY });
		const row = db.select().from(connections).where(eq(connections.id, id)).get()!;
		expect(row.credentialEnc).not.toContain('access-1');
		expect(getCredential(db, id, KEY)).toBe('access-1');
		expect(getCredential(db, createConnection(db, { provider: 'manual', institutionName: 'Cash', appKey: KEY }), KEY)).toBeNull();
	});
	it('tracks status, errors, cursor, and success time', () => {
		const id = createConnection(db, { provider: 'simplefin', institutionName: 'SF', credential: 'https://u:p@bridge/x', appKey: KEY });
		setConnectionStatus(db, id, 'error', 'boom');
		expect(db.select().from(connections).where(eq(connections.id, id)).get()!.lastError).toBe('boom');
		expect(listActiveConnections(db).map((c) => c.id)).toContain(id);
		recordConnectionSuccess(db, id, 'cursor-9', '2026-09-08T03:00:00.000Z');
		const row = db.select().from(connections).where(eq(connections.id, id)).get()!;
		expect(row.cursor).toBe('cursor-9');
		expect(row.lastSuccessAt).toBe('2026-09-08T03:00:00.000Z');
		expect(row.status).toBe('active');
		expect(row.lastError).toBeNull();
		setConnectionStatus(db, id, 'disabled');
		expect(listActiveConnections(db).map((c) => c.id)).not.toContain(id);
	});
});

describe('accounts, balances, terms', () => {
	it('upserts accounts without touching type or flags after creation', () => {
		const c = createConnection(db, { provider: 'plaid', institutionName: 'Chase', appKey: KEY });
		const a = upsertAccount(db, c, { externalId: 'acc-1', name: 'Sapphire', mask: '1234', type: 'credit' });
		expect(a.created).toBe(true);
		const again = upsertAccount(db, c, { externalId: 'acc-1', name: 'Sapphire Preferred', mask: '1234', type: 'checking' });
		expect(again).toEqual({ id: a.id, created: false });
		const row = db.select().from(accounts).where(eq(accounts.id, a.id)).get()!;
		expect(row.name).toBe('Sapphire Preferred');
		expect(row.type).toBe('credit');
		expect(row.onBudget).toBe(true);
		expect(row.isDebt).toBe(true);
	});
	it('appends balances and terms only on change', () => {
		const c = createConnection(db, { provider: 'plaid', institutionName: 'Chase', appKey: KEY });
		const a = upsertAccount(db, c, { externalId: 'acc-1', name: 'Card', type: 'credit' }).id;
		appendBalance(db, a, { asOf: '2026-09-07', current: -50000, source: 'sync' });
		appendBalance(db, a, { asOf: '2026-09-08', current: -51000, source: 'sync' });
		expect(latestBalance(db, a)?.current).toBe(-51000);
		expect(db.select().from(accountBalances).all().length).toBe(2);
		expect(appendTermsIfChanged(db, a, { asOf: '2026-09-07', aprBps: 2749, minPayment: 3500, nextDueDate: '2026-09-15', source: 'provider' })).toBe(true);
		expect(appendTermsIfChanged(db, a, { asOf: '2026-09-08', aprBps: 2749, minPayment: 3500, nextDueDate: '2026-09-15', source: 'provider' })).toBe(false);
		expect(appendTermsIfChanged(db, a, { asOf: '2026-09-09', aprBps: 2724, minPayment: 3500, nextDueDate: '2026-09-15', source: 'provider' })).toBe(true);
		expect(appendTermsIfChanged(db, a, { asOf: '2026-09-09', aprBps: 2724, source: 'manual' })).toBe(true);
		expect(db.select().from(accountTerms).all().length).toBe(3);
		expect(latestTerms(db, a)?.aprBps).toBe(2724);
	});
});
