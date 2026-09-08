import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { accounts, accountBalances, accountTerms, transactions, connections, categoryGroups } from '$lib/server/db/schema';
import { createTransaction } from '$lib/server/ledger/transactions';
import { createCategory } from '$lib/server/ledger/categories';
import { driftForAccount } from '$lib/server/reconcile';
import { POST as createConn } from '../connections/+server';
import { POST as connStatus } from '../connections/[id]/status/+server';
import { POST as patchAccount } from './[id]/+server';
import { POST as balance } from './[id]/balance/+server';
import { POST as terms } from './[id]/terms/+server';
import { POST as adjust } from './[id]/adjust/+server';
import { POST as convention } from './[id]/convention/+server';
import { POST as importRoute } from './[id]/import/+server';
import { eq } from 'drizzle-orm';

let dir: string;
const cfg = (d: string) => ({
	dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle',
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, backupHour: 4, backupKeep: 30, plaid: { clientId: null, secret: null, env: 'sandbox' as const },
	schedulerEnabled: false, plaidClientName: 'shiso'
});
const req = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'shiso-routes-'));
	const c = cfg(dir); setConfig(c); startup(c, '2026-09-08');
});
afterEach(() => { resetForTests(); rmSync(dir, { recursive: true, force: true }); });

const CSV = `Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By
09/01/2026,09/02/2026,APPLE.COM/BILL,Apple,Other,Purchase,10.59,J
`;
const multipart = (name: string, text: string) => { const fd = new FormData(); fd.set('file', new File([text], name, { type: 'text/csv' })); return new Request('http://localhost/x', { method: 'POST', body: fd }); };

describe('account and connection routes', () => {
	it('creates a manual connection, edits an account, appends balance and terms, adjusts drift, imports csv', async () => {
		const db = getDb();
		const { connectionId, accountIds } = await (await createConn({ request: req({ institutionName: 'Apple', accounts: [{ name: 'Apple Card', type: 'credit' }] }) } as never)).json();
		const card = accountIds[0];
		expect((await patchAccount({ request: req({ name: 'Apple Card (Titanium)', onBudget: true }), params: { id: String(card) } } as never)).status).toBe(200);
		expect(db.select().from(accounts).where(eq(accounts.id, card)).get()!.name).toBe('Apple Card (Titanium)');
		expect((await balance({ request: req({ current: -12345, asOf: '2026-09-08' }), params: { id: String(card) } } as never)).status).toBe(200);
		expect(db.select().from(accountBalances).all()).toHaveLength(1);
		expect((await terms({ request: req({ asOf: '2026-09-08', aprBps: 2649, minPayment: 2500 }), params: { id: String(card) } } as never)).status).toBe(200);
		expect(db.select().from(accountTerms).all()[0]).toMatchObject({ aprBps: 2649, source: 'manual' });
		createTransaction(db, { accountId: card, externalId: 't', postedDate: '2026-09-03', amount: -10000, payeeRaw: 'X', source: 'sync' });
		const drift = driftForAccount(db, card).drift!; expect(drift).toBe(-2345);
		expect((await adjust({ request: req({ amount: drift, date: '2026-09-08' }), params: { id: String(card) } } as never)).status).toBe(200);
		expect(driftForAccount(db, card).drift).toBe(0);
		expect((await convention({ request: req({ convention: 'exclude_pending' }), params: { id: String(card) } } as never)).status).toBe(200);
		expect(driftForAccount(db, card).convention).toBe('exclude_pending');
		const imp = await (await importRoute({ request: multipart('apple.csv', CSV), params: { id: String(card) } } as never)).json();
		expect(imp).toMatchObject({ created: 1, duplicates: 0 });
		expect(db.select().from(transactions).where(eq(transactions.source, 'import')).get()!.processedAt).not.toBeNull();
		expect((await connStatus({ request: req({ status: 'disabled' }), params: { id: String(connectionId) } } as never)).status).toBe(200);
		expect(db.select().from(connections).where(eq(connections.id, connectionId)).get()!.status).toBe('disabled');
	});
	it('rejects a stale adjustment (409), a bad convention (400), and a non-Apple csv (400)', async () => {
		const db = getDb();
		const { accountIds } = await (await createConn({ request: req({ institutionName: 'B', accounts: [{ name: 'Chk', type: 'checking' }] }) } as never)).json();
		const id = accountIds[0];
		const stale = await adjust({ request: req({ amount: 999, date: '2026-09-08' }), params: { id: String(id) } } as never);
		expect(stale.status).toBe(409); expect(db.select().from(transactions).all()).toHaveLength(0);
		expect((await convention({ request: req({ convention: 'sometimes' }), params: { id: String(id) } } as never)).status).toBe(400);
		expect((await importRoute({ request: multipart('x.csv', 'Date,Amount\n1,2\n'), params: { id: String(id) } } as never)).status).toBe(400);
	});
	it('rejects reassigning a debt account off debt while a payment category points at it (409), and an unknown type (400)', async () => {
		const db = getDb();
		const { accountIds } = await (await createConn({ request: req({ institutionName: 'C', accounts: [{ name: 'Card', type: 'credit' }] }) } as never)).json();
		const id = accountIds[0];
		const debtGroup = db.select({ id: categoryGroups.id }).from(categoryGroups).where(eq(categoryGroups.name, 'Debt Payments')).get()!.id;
		createCategory(db, { groupId: debtGroup, name: 'Card', kind: 'debt_payment', accountId: id });
		const res = await patchAccount({ request: req({ type: 'checking' }), params: { id: String(id) } } as never);
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe('ACCOUNT_HAS_PAYMENT_CATEGORY');
		const row = db.select().from(accounts).where(eq(accounts.id, id)).get()!;
		expect(row.type).toBe('credit');
		expect(row.isDebt).toBe(true);
		expect((await patchAccount({ request: req({ type: 'boat' }), params: { id: String(id) } } as never)).status).toBe(400);
	});
});
