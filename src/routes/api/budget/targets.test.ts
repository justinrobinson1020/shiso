import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { budgetAssignments, categoryGroups, categoryTargets } from '$lib/server/db/schema';
import { createCategory, systemCategoryId } from '$lib/server/ledger/categories';
import { currentPeriodId } from '$lib/server/budget/periods';
import { POST as targetsRoute } from './targets/+server';
import { POST as clearRoute } from './targets/[categoryId]/clear/+server';
import { POST as fundRoute } from './fund-targets/+server';

let dir: string;
const cfg = (d: string) => ({
	dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle',
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, backupHour: 4, backupKeep: 30, plaid: { clientId: null, secret: null, env: 'sandbox' as const },
	schedulerEnabled: false, plaidClientName: 'shiso'
});
const req = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiso-routes-')); const c = cfg(dir); setConfig(c); startup(c, '2026-09-08'); });
afterEach(() => { resetForTests(); rmSync(dir, { recursive: true, force: true }); });

describe('target routes', () => {
	it('sets a target, funds it, and clears it', async () => {
		const db = getDb(); const p = currentPeriodId(db, 'semi_monthly', '2026-09-08');
		const group = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Spending')).get()!.id;
		const a = createCategory(db, { groupId: group, name: 'A', kind: 'spending' });
		expect((await targetsRoute({ request: req({ categoryId: a, kind: 'monthly', amount: 40000 }) } as never)).status).toBe(200);
		expect(db.select().from(categoryTargets).all()).toMatchObject([{ categoryId: a, kind: 'monthly', amount: 40000, targetDate: null }]);
		const res = await fundRoute({ request: req({ periodId: p }) } as never);
		expect(res.status).toBe(200); expect(await res.json()).toEqual({ funded: [{ categoryId: a, amount: 20000 }] });
		expect(db.select().from(budgetAssignments).all()).toMatchObject([{ periodId: p, categoryId: a, assigned: 20000 }]);
		expect((await clearRoute({ params: { categoryId: String(a) } } as never)).status).toBe(200);
		expect(db.select().from(categoryTargets).all()).toHaveLength(0);
	});
	it('rejects a target on a no-envelope kind (409), a by_date target without a date (409), and a bad kind (400)', async () => {
		const db = getDb();
		const res = await targetsRoute({ request: req({ categoryId: systemCategoryId(db, 'income'), kind: 'monthly', amount: 100 }) } as never);
		expect(res.status).toBe(409); expect((await res.json()).code).toBe('TARGET_NO_ENVELOPE');
		const group = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Spending')).get()!.id;
		const a = createCategory(db, { groupId: group, name: 'A', kind: 'spending' });
		const nodate = await targetsRoute({ request: req({ categoryId: a, kind: 'by_date', amount: 100 }) } as never);
		expect(nodate.status).toBe(409); expect((await nodate.json()).code).toBe('TARGET_DATE_MISMATCH');
		expect((await targetsRoute({ request: req({ categoryId: a, kind: 'weekly', amount: 100 }) } as never)).status).toBe(400);
		expect(db.select().from(categoryTargets).all()).toHaveLength(0);
	});
	it('refuses to fund a category without a target (409)', async () => {
		const db = getDb(); const p = currentPeriodId(db, 'semi_monthly', '2026-09-08');
		const group = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Spending')).get()!.id;
		const a = createCategory(db, { groupId: group, name: 'A', kind: 'spending' });
		const res = await fundRoute({ request: req({ periodId: p, categoryId: a }) } as never);
		expect(res.status).toBe(409); expect((await res.json()).code).toBe('NO_TARGET');
		expect(db.select().from(budgetAssignments).all()).toHaveLength(0);
	});
});
