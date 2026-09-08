import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { bills, billOccurrences, incomeSources, incomeOccurrences, categoryGroups } from '$lib/server/db/schema';
import { createConnection, upsertAccount } from '$lib/server/sync/connections';
import { createCategory, systemCategoryId } from '$lib/server/ledger/categories';
import { POST as createBillRoute } from './+server';
import { POST as patchBillRoute } from './[id]/+server';
import { POST as createIncomeRoute } from '../income/+server';
import { POST as occurrenceRoute } from '../occurrences/[id]/+server';
import { POST as incomeOccurrenceRoute } from '../income-occurrences/[id]/+server';

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

function setup() {
	const db = getDb();
	const conn = createConnection(db, { provider: 'manual', institutionName: 'T', appKey: 'k'.repeat(40) });
	const chk = upsertAccount(db, conn, { externalId: 'chk', name: 'Checking', type: 'checking' }).id;
	const group = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Bills')).get()!.id;
	return { db, chk, rent: createCategory(db, { groupId: group, name: 'Rent', kind: 'bill' }) };
}

describe('bill and income routes', () => {
	it('creates a bill with occurrences, edits it, marks an occurrence paid and unmarks it', async () => {
		const { db, chk, rent } = setup();
		const { id } = await (await createBillRoute({ request: req({ name: 'Rent', categoryId: rent, payFromAccountId: chk, expectedAmount: 227445, cadence: 'monthly', dueDay: 1 }) } as never)).json();
		expect(db.select().from(billOccurrences).where(eq(billOccurrences.billId, id)).all().length).toBeGreaterThan(0);
		expect((await patchBillRoute({ request: req({ expectedAmount: 230000, active: false }), params: { id: String(id) } } as never)).status).toBe(200);
		expect(db.select().from(bills).where(eq(bills.id, id)).get()).toMatchObject({ expectedAmount: 230000, active: false });
		const occ = db.select().from(billOccurrences).where(eq(billOccurrences.billId, id)).all()[0];
		expect((await occurrenceRoute({ request: req({ action: 'paid', amount: 227445 }), params: { id: String(occ.id) } } as never)).status).toBe(200);
		expect(db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id)).get()).toMatchObject({ status: 'paid', paidAmount: 227445, markedBy: 'manual' });
		expect((await occurrenceRoute({ request: req({ action: 'unmark' }), params: { id: String(occ.id) } } as never)).status).toBe(200);
		expect(db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id)).get()!.status).toBe('pending');
	});
	it('creates income and marks an occurrence received; rejects a monthly bill without dueDay (400) and an unknown action (400)', async () => {
		const { db, chk, rent } = setup();
		const { id } = await (await createIncomeRoute({ request: req({ name: 'Salary', categoryId: systemCategoryId(db, 'income'), depositAccountId: chk, expectedAmount: 275000, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30 }) } as never)).json();
		const occ = db.select().from(incomeOccurrences).where(eq(incomeOccurrences.incomeSourceId, id)).all()[0];
		expect((await incomeOccurrenceRoute({ request: req({ action: 'received' }), params: { id: String(occ.id) } } as never)).status).toBe(200);
		expect(db.select().from(incomeOccurrences).where(eq(incomeOccurrences.id, occ.id)).get()).toMatchObject({ status: 'paid', receivedAmount: 275000 });
		expect((await createBillRoute({ request: req({ name: 'X', categoryId: rent, payFromAccountId: chk, expectedAmount: 1, cadence: 'monthly' }) } as never)).status).toBe(400);
		expect(db.select().from(bills).all()).toHaveLength(0);
		expect((await occurrenceRoute({ request: req({ action: 'explode' }), params: { id: String(occ.id) } } as never)).status).toBe(400);
	});
});
