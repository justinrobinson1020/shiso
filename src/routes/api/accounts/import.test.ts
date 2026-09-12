import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { transactions, accounts } from '$lib/server/db/schema';
import { createConnection, upsertAccount } from '$lib/server/sync/connections';
import { POST } from './[id]/import/+server';
import { eq } from 'drizzle-orm';
let dir: string; let card: number;
const cfg = (d: string) => ({ dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle', cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, backupHour: 4, backupKeep: 30, plaid: { clientId: null, secret: null, env: 'sandbox' as const }, schedulerEnabled: false, plaidClientName: 'shiso' });
const fx = (n: string) => readFileSync(new URL(`../../../lib/server/import/formats/fixtures/${n}`, import.meta.url), 'utf8');
const req = (text: string, name: string, dryRun = false) => { const fd = new FormData(); fd.set('file', new File([text], name)); if (dryRun) fd.set('dryRun', '1'); return { request: new Request('http://localhost/x', { method: 'POST', body: fd }), params: { id: String(card) } } as never; };
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'shiso-import-')); const c = cfg(dir); setConfig(c); startup(c, '2026-09-08');
	const db = getDb(); const conn = createConnection(db, { provider: 'manual', institutionName: 'Chase', appKey: c.appKey });
	card = upsertAccount(db, conn, { externalId: 'x', name: 'Freedom', type: 'credit', mask: '1403' }).id;
});
afterEach(() => { resetForTests(); rmSync(dir, { recursive: true, force: true }); });
describe('POST /api/accounts/[id]/import', () => {
	it('imports a statement, seeds the opening row, and post-processes', async () => {
		const res = await POST(req(fx('chase-dec-jan.txt'), 's.txt')); expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ format: 'chase', created: 5, duplicates: 0, matched: 0, balances: 1, opening: { seeded: -231439, date: '2024-12-02' }, dryRun: false });
		expect(body.processed).toBeGreaterThanOrEqual(5);   // the five rows, plus the seeded opening row if createTransaction leaves it unprocessed
		expect(getDb().select().from(transactions).where(eq(transactions.accountId, card)).all().filter((t) => t.processedAt == null)).toHaveLength(0);
	});
	it('dry run reports without writing', async () => {
		const body = await (await POST(req(fx('chase-dec-jan.txt'), 's.txt', true))).json();
		expect(body).toMatchObject({ created: 5, dryRun: true, processed: 0 });
		expect(getDb().select().from(transactions).where(eq(transactions.accountId, card)).all()).toHaveLength(0);
	});
	it('accepts a mismatched mask when the form lists it as an accepted mask', async () => {
		getDb().update(accounts).set({ mask: '5692' }).where(eq(accounts.id, card)).run();
		const fd = new FormData(); fd.set('file', new File([fx('chase-dec-jan.txt')], 's.txt')); fd.set('dryRun', '1'); fd.append('acceptMask', '1403');
		const res = await POST({ request: new Request('http://localhost/x', { method: 'POST', body: fd }), params: { id: String(card) } } as never);
		expect(res.status).toBe(200); expect((await res.json()).created).toBe(5);
	});
	it('rejects a mask mismatch, an unreconciled statement, and unknown content with 400', async () => {
		getDb().update(accounts).set({ mask: '5692' }).where(eq(accounts.id, card)).run();
		expect((await POST(req(fx('chase-dec-jan.txt'), 's.txt'))).status).toBe(400);
		getDb().update(accounts).set({ mask: '1403' }).where(eq(accounts.id, card)).run();
		const r = await POST(req(fx('chase-dec-jan.txt').replace('$1,899.66', '$1,899.67'), 's.txt'));
		expect(r.status).toBe(400); expect((await r.json()).error).toMatch(/does not reconcile/);
		expect((await POST(req('hello', 'x.txt'))).status).toBe(400);
	});
	it('rejects a malformed Chase statement (Opening/Closing Date without parseable dates) with 400 and the parser message', async () => {
		// isChaseStatement only checks for the "Opening/Closing Date" label + chase.com, so it still
		// routes here; parseChaseStatement's own regex then fails to find the date range and throws a
		// plain Error, which the route must map to a 400, not let bubble up as a 500.
		const text = fx('chase-dec-jan.txt').replace('12/03/24 - 01/02/25', 'unknown');
		const r = await POST(req(text, 's.txt'));
		expect(r.status).toBe(400);
		expect((await r.json()).error).toBe('chase statement: no Opening/Closing Date');
	});
});
