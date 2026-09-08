import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { budgetAssignments, categoryGroups } from '$lib/server/db/schema';
import { createCategory, systemCategoryId } from '$lib/server/ledger/categories';
import { currentPeriodId } from '$lib/server/budget/periods';
import { POST as assignRoute } from './assign/+server';
import { POST as moveRoute } from './move/+server';
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

describe('budget routes', () => {
	it('assigns and moves money', async () => {
		const db = getDb(); const p = currentPeriodId(db, 'semi_monthly', '2026-09-08');
		const group = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Spending')).get()!.id;
		const a = createCategory(db, { groupId: group, name: 'A', kind: 'spending' }); const b = createCategory(db, { groupId: group, name: 'B', kind: 'spending' });
		expect((await assignRoute({ request: req({ periodId: p, categoryId: a, assigned: 5000 }) } as never)).status).toBe(200);
		expect((await moveRoute({ request: req({ periodId: p, fromCategoryId: a, toCategoryId: b, amount: 2000 }) } as never)).status).toBe(200);
		const rows = db.select().from(budgetAssignments).where(eq(budgetAssignments.periodId, p)).all();
		expect(Object.fromEntries(rows.map((r) => [r.categoryId, r.assigned]))).toEqual({ [a]: 3000, [b]: 2000 });
	});
	it('rejects assigning to a category with no envelope (409) and a non-integer amount (400)', async () => {
		const db = getDb(); const p = currentPeriodId(db, 'semi_monthly', '2026-09-08');
		const res = await assignRoute({ request: req({ periodId: p, categoryId: systemCategoryId(db, 'income'), assigned: 1 }) } as never);
		expect(res.status).toBe(409); expect((await res.json()).code).toBe('ASSIGN_NO_ENVELOPE');
		expect((await assignRoute({ request: req({ periodId: p, categoryId: 1, assigned: 1.5 }) } as never)).status).toBe(400);
		expect(db.select().from(budgetAssignments).all()).toHaveLength(0);
	});
});
