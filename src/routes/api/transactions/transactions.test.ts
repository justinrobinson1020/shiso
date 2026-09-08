import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { transactions, transactionSplits, payeeRules, categoryGroups } from '$lib/server/db/schema';
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
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, plaid: { clientId: null, secret: null, env: 'sandbox' as const },
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
	it('rejects splits that do not sum (409) and deleting a synced row (409)', async () => {
		const db = getDb(); const { chk } = accountsFor(db);
		const s = createTransaction(db, { accountId: chk, externalId: 's', postedDate: '2026-09-04', amount: -5000, payeeRaw: 'S', source: 'sync' });
		const bad = await patch({ request: req({ splits: [{ categoryId: uncategorizedId(db), amount: -100 }] }), params: { id: String(s) } } as never);
		expect(bad.status).toBe(409); expect((await bad.json()).code).toBe('SPLITS_DO_NOT_SUM');
		expect(db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, s)).get()!.amount).toBe(-5000);
		const d = await del({ request: req({}), params: { id: String(s) } } as never);
		expect(d.status).toBe(409); expect(getTransaction(db, s).deletedAt).toBeNull();
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
