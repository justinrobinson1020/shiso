import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { categoryGroups } from '$lib/server/db/schema';
import { createConnection, upsertAccount } from '$lib/server/sync/connections';
import { createCategory } from '$lib/server/ledger/categories';
import { createTransaction, getTransaction } from '$lib/server/ledger/transactions';
import { getProviderCategoryMap } from '$lib/server/sync/postprocess';
import { GET, POST } from './+server';
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

describe('provider category map routes', () => {
	it('saves the map, recategorizes existing rows, and lists provider categories with counts', async () => {
		const db = getDb();
		const conn = createConnection(db, { provider: 'manual', institutionName: 'T', appKey: 'k'.repeat(40) });
		const chk = upsertAccount(db, conn, { externalId: 'chk', name: 'Checking', type: 'checking' }).id;
		const group = db.select({ id: categoryGroups.id }).from(categoryGroups).where(eq(categoryGroups.name, 'Spending')).get()!.id;
		const groceries = createCategory(db, { groupId: group, name: 'Groceries', kind: 'spending' });
		const t = createTransaction(db, { accountId: chk, externalId: 'x', postedDate: '2026-09-04', amount: -1200, payeeRaw: 'STORE', providerCategory: 'FOOD_AND_DRINK_GROCERIES', source: 'sync' });

		const before = await (await GET({} as never)).json();
		expect(before).toEqual({ map: {}, providerCategories: [{ key: 'FOOD_AND_DRINK_GROCERIES', count: 1 }] });

		const res = await POST({ request: req({ map: { FOOD_AND_DRINK_GROCERIES: groceries }, applyToExisting: true }) } as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, categorized: 1 });
		expect(getTransaction(db, t).splits[0].categoryId).toBe(groceries);
		expect(getProviderCategoryMap(db)).toEqual({ FOOD_AND_DRINK_GROCERIES: groceries });

		const after = await (await GET({} as never)).json();
		expect(after.map).toEqual({ FOOD_AND_DRINK_GROCERIES: groceries });
	});
	it('rejects a value that is not an existing category id (400), leaving the setting unchanged', async () => {
		const db = getDb();
		const res = await POST({ request: req({ map: { FOOD_AND_DRINK: 999999 } }) } as never);
		expect(res.status).toBe(400);
		expect(getProviderCategoryMap(db)).toEqual({});
	});
});
