import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { transactions, transactionSplits, payeeRules, categoryGroups, billOccurrences } from '$lib/server/db/schema';
import { createBill } from '$lib/server/bills/bills';
import { generateOccurrences } from '$lib/server/bills/schedule';
import { matchAll } from '$lib/server/bills/matching';
import { createConnection, upsertAccount } from '$lib/server/sync/connections';
import { createCategory, uncategorizedId } from '$lib/server/ledger/categories';
import { createTransaction, getTransaction } from '$lib/server/ledger/transactions';
import { POST as create } from './+server';
import { POST as patch } from './[id]/+server';
import { POST as review } from './[id]/review/+server';
import { POST as del } from './[id]/delete/+server';
import { POST as link } from './[id]/link/+server';
import { POST as unlink } from './[id]/unlink/+server';
import { POST as rules } from '../payee-rules/+server';
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

function accountsFor(db: ReturnType<typeof getDb>) {
	const conn = createConnection(db, { provider: 'manual', institutionName: 'T', appKey: 'k'.repeat(40) });
	return { chk: upsertAccount(db, conn, { externalId: 'chk', name: 'Checking', type: 'checking' }).id, card: upsertAccount(db, conn, { externalId: 'card', name: 'Card', type: 'credit' }).id };
}
describe('transaction routes', () => {
	it('creates, edits, splits, links, unlinks, clears review, deletes', async () => {
		const db = getDb(); const { chk, card } = accountsFor(db);
		const group = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Spending')).get()!.id;
		const g = createCategory(db, { groupId: group, name: 'G', kind: 'spending' });
		const { id } = await (await create({ request: req({ accountId: chk, postedDate: '2026-09-03', amount: -1000, payee: 'Shop' }) } as never)).json();
		expect((await patch({ request: req({ payee: 'The Shop', memo: 'm', splits: [{ categoryId: g, amount: -600 }, { categoryId: uncategorizedId(db), amount: -400 }] }), params: { id: String(id) } } as never)).status).toBe(200);
		let t = getTransaction(db, id); expect(t.payee).toBe('The Shop'); expect(t.memo).toBe('m'); expect(t.splits).toHaveLength(2);
		const a = createTransaction(db, { accountId: chk, externalId: 'x', postedDate: '2026-09-04', amount: -5000, payeeRaw: 'PAY', source: 'sync' });
		const b = createTransaction(db, { accountId: card, externalId: 'y', postedDate: '2026-09-04', amount: 5000, payeeRaw: 'PAY', source: 'sync' });
		expect((await link({ request: req({ peerId: b }), params: { id: String(a) } } as never)).status).toBe(200);
		expect(getTransaction(db, a).transferPeerId).toBe(b);
		expect((await unlink({ request: req({}), params: { id: String(a) } } as never)).status).toBe(200);
		t = getTransaction(db, a); expect(t.transferPeerId).toBeNull(); expect(t.needsReview).toBe(true);
		expect((await review({ request: req({}), params: { id: String(a) } } as never)).status).toBe(200);
		expect(getTransaction(db, a).needsReview).toBe(false);
		expect((await del({ request: req({}), params: { id: String(id) } } as never)).status).toBe(200);
		expect(getTransaction(db, id).deletedAt).not.toBeNull();
	});
	it('deleting a manual payment reopens the bill occurrence it had settled', async () => {
		const db = getDb(); const { chk } = accountsFor(db);
		const group = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Bills')).get()!.id;
		const rentCat = createCategory(db, { groupId: group, name: 'Rent', kind: 'bill' });
		const billId = createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 225000, toleranceAbs: 100, cadence: 'monthly', dueDay: 1, matchPattern: 'landlord' });
		generateOccurrences(db, { todayIso: '2026-09-08', cadence: 'semi_monthly', graceDays: 3 });
		const { id } = await (await create({ request: req({ accountId: chk, postedDate: '2026-09-03', amount: -225000, payee: 'LANDLORD LLC' }) } as never)).json();
		matchAll(db, { todayIso: '2026-09-08', graceDays: 3 });
		const occ = () => db.select().from(billOccurrences).where(eq(billOccurrences.billId, billId)).all().sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
		expect(occ().status).toBe('paid'); expect(occ().paidAmount).toBe(225000);
		expect((await del({ request: req({}), params: { id: String(id) } } as never)).status).toBe(200);
		expect(getTransaction(db, id).deletedAt).not.toBeNull();
		expect(occ().status).toBe('pending'); expect(occ().paidAmount).toBe(0);
	});
	it('rejects splits that do not sum (409) and deleting a synced row (409)', async () => {
		const db = getDb(); const { chk } = accountsFor(db);
		const s = createTransaction(db, { accountId: chk, externalId: 's', postedDate: '2026-09-04', amount: -5000, payeeRaw: 'S', source: 'sync' });
		const bad = await patch({ request: req({ splits: [{ categoryId: uncategorizedId(db), amount: -100 }] }), params: { id: String(s) } } as never);
		expect(bad.status).toBe(409); expect((await bad.json()).code).toBe('SPLITS_DO_NOT_SUM');
		expect(db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, s)).get()!.amount).toBe(-5000);
		const d = await del({ request: req({}), params: { id: String(s) } } as never);
		expect(d.status).toBe(409); expect(getTransaction(db, s).deletedAt).toBeNull();
	});
	it('rejects a non-integer amount (400) and a postedDate outside any ensured period (400), writing nothing', async () => {
		const db = getDb(); const { chk } = accountsFor(db);
		const before = db.select().from(transactions).all().length;
		const badAmount = await create({ request: req({ accountId: chk, postedDate: '2026-09-03', amount: 12.5, payee: 'Shop' }) } as never);
		expect(badAmount.status).toBe(400);
		const badDate = await create({ request: req({ accountId: chk, postedDate: '2020-01-01', amount: -1000, payee: 'Shop' }) } as never);
		expect(badDate.status).toBe(400);
		expect(db.select().from(transactions).all()).toHaveLength(before);
	});
	it('rejects linking two transactions whose amounts are not opposite (409), leaving them unlinked', async () => {
		const db = getDb(); const { chk, card } = accountsFor(db);
		const a = createTransaction(db, { accountId: chk, externalId: 'la', postedDate: '2026-09-04', amount: -5000, payeeRaw: 'PAY', source: 'sync' });
		const b = createTransaction(db, { accountId: card, externalId: 'lb', postedDate: '2026-09-04', amount: 4000, payeeRaw: 'PAY', source: 'sync' });
		const res = await link({ request: req({ peerId: b }), params: { id: String(a) } } as never);
		expect(res.status).toBe(409); expect((await res.json()).code).toBe('TRANSFER_NOT_OPPOSITE');
		expect(getTransaction(db, a).transferPeerId).toBeNull();
		expect(getTransaction(db, b).transferPeerId).toBeNull();
	});
	it('rejects unlinking with a non-integer id (400)', async () => {
		const res = await unlink({ request: req({}), params: { id: 'not-a-number' } } as never);
		expect(res.status).toBe(400);
	});
	it('rejects clearing review on an unknown transaction (404)', async () => {
		const res = await review({ request: req({}), params: { id: '999999' } } as never);
		expect(res.status).toBe(404);
	});
	it('creates a payee rule and applies it to existing rows', async () => {
		const db = getDb(); const { chk } = accountsFor(db);
		const t = createTransaction(db, { accountId: chk, externalId: 'r', postedDate: '2026-09-04', amount: -700, payeeRaw: 'SQ *BLUE BOTTLE 42', source: 'sync' });
		const res = await (await rules({ request: req({ pattern: 'BLUE BOTTLE', payee: 'Blue Bottle', applyToExisting: true }) } as never)).json();
		expect(res.applied.renamed).toBe(1); expect(getTransaction(db, t).payee).toBe('Blue Bottle');
		expect(db.select().from(payeeRules).all()).toHaveLength(1);
		expect((await rules({ request: req({ pattern: '', payee: 'x' }) } as never)).status).toBe(400);
	});
});
