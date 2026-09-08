import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { categories } from '$lib/server/db/schema';
import { createConnection, upsertAccount } from '$lib/server/sync/connections';
import { POST as createGroupRoute } from '../category-groups/+server';
import { POST as createRoute } from './+server';
import { POST as patchRoute } from './[id]/+server';
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

describe('category routes', () => {
	it('creates a group and a category, then renames and hides it', async () => {
		const g = await (await createGroupRoute({ request: req({ name: 'Fun' }) } as never)).json();
		const c = await (await createRoute({ request: req({ groupId: g.id, name: 'Games', kind: 'spending' }) } as never)).json();
		expect((await patchRoute({ request: req({ name: 'Video games', hidden: true }), params: { id: String(c.id) } } as never)).status).toBe(200);
		const row = getDb().select().from(categories).where(eq(categories.id, c.id)).get()!;
		expect(row.name).toBe('Video games'); expect(row.hidden).toBe(true); expect(row.groupId).toBe(g.id);
	});
	it('rejects a second payment category for the same account with 409', async () => {
		const db = getDb();
		const conn = createConnection(db, { provider: 'manual', institutionName: 'T', appKey: 'k'.repeat(40) });
		const card = upsertAccount(db, conn, { externalId: 'c', name: 'C', type: 'credit' }).id;
		const g = await (await createGroupRoute({ request: req({ name: 'Debt' }) } as never)).json();
		expect((await createRoute({ request: req({ groupId: g.id, name: 'C', kind: 'debt_payment', accountId: card }) } as never)).status).toBe(200);
		const dup = await createRoute({ request: req({ groupId: g.id, name: 'C again', kind: 'debt_payment', accountId: card }) } as never);
		expect(dup.status).toBe(409); expect((await dup.json()).code).toBe('DEBT_CATEGORY_DUPLICATE');
		expect(db.select().from(categories).where(eq(categories.accountId, card)).all()).toHaveLength(1);
	});
});
