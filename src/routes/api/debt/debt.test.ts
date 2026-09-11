import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { budgetAssignments, categoryGroups, plannedExtras, promoBalances } from '$lib/server/db/schema';
import { createConnection, upsertAccount, appendBalance } from '$lib/server/sync/connections';
import { createCategory } from '$lib/server/ledger/categories';
import { createBill } from '$lib/server/bills/bills';
import { currentPeriodId } from '$lib/server/budget/periods';
import { POST as extrasRoute } from './extras/+server';
import { POST as fundRoute } from './fund/+server';
import { POST as promosRoute } from './promos/+server';
import { POST as promoRoute } from './promos/[id]/+server';
import { POST as closeRoute } from './promos/[id]/close/+server';

let dir: string;
const cfg = (d: string) => ({
	dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle',
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, backupHour: 4, backupKeep: 30, plaid: { clientId: null, secret: null, env: 'sandbox' as const },
	schedulerEnabled: false, plaidClientName: 'shiso'
});
const req = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

function seed() {
	const db = getDb();
	const conn = createConnection(db, { provider: 'manual', institutionName: 'Bank', appKey: 'k'.repeat(40) });
	const checking = upsertAccount(db, conn, { externalId: 'chk', name: 'Checking', type: 'checking' }).id;
	const card = upsertAccount(db, conn, { externalId: 'card', name: 'Card', type: 'credit' }).id;
	const debtGroup = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Debt Payments')).get()!.id;
	const billsGroup = db.select().from(categoryGroups).where(eq(categoryGroups.name, 'Bills')).get()!.id;
	const cardPay = createCategory(db, { groupId: debtGroup, name: 'Card', kind: 'debt_payment', accountId: card });
	const rent = createCategory(db, { groupId: billsGroup, name: 'Rent', kind: 'bill' });
	const p = currentPeriodId(db, 'semi_monthly', '2026-09-08');
	return { db, checking, card, cardPay, rent, p };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiso-routes-')); const c = cfg(dir); setConfig(c); startup(c, '2026-09-08'); });
afterEach(() => { resetForTests(); rmSync(dir, { recursive: true, force: true }); });

describe('debt routes', () => {
	it('saves a planned extra and funds the shortfall', async () => {
		const { db, checking, card, cardPay, p } = seed();
		appendBalance(db, checking, { asOf: '2026-09-07', current: 250000, source: 'manual' });
		appendBalance(db, card, { asOf: '2026-09-07', current: -80000, source: 'manual' });
		createBill(db, { name: 'Card', categoryId: cardPay, payFromAccountId: checking, expectedAmount: 3500, cadence: 'monthly', dueDay: 25, linkedDebtAccountId: card });
		expect((await extrasRoute({ request: req({ periodId: p, accountId: card, extraAmount: 10000 }) } as never)).status).toBe(200);
		expect(db.select().from(plannedExtras).all()).toMatchObject([{ accountId: card, periodId: p, extraAmount: 10000 }]);
		const res = await fundRoute({ request: req({ periodId: p, accountId: card }) } as never);
		expect(res.status).toBe(200); expect(await res.json()).toEqual({ categoryId: cardPay, shortfall: 13500, assigned: 13500 });
		expect(db.select().from(budgetAssignments).all()).toMatchObject([{ periodId: p, categoryId: cardPay, assigned: 13500 }]);
	});
	it('rejects an extra on a cash account (409) and a non-integer amount (400)', async () => {
		const { db, checking, card, p } = seed();
		const res = await extrasRoute({ request: req({ periodId: p, accountId: checking, extraAmount: 100 }) } as never);
		expect(res.status).toBe(409); expect((await res.json()).code).toBe('NOT_DEBT_ACCOUNT');
		expect((await extrasRoute({ request: req({ periodId: p, accountId: card, extraAmount: 1.5 }) } as never)).status).toBe(400);
		expect(db.select().from(plannedExtras).all()).toHaveLength(0);
	});
	it('refuses to fund a debt with no payment category (409)', async () => {
		const { db, checking, p } = seed();
		const conn = createConnection(db, { provider: 'manual', institutionName: 'Loans', appKey: 'k'.repeat(40) });
		const loan = upsertAccount(db, conn, { externalId: 'loan', name: 'Loan', type: 'loan' }).id;
		const res = await fundRoute({ request: req({ periodId: p, accountId: loan }) } as never);
		expect(res.status).toBe(409); expect((await res.json()).code).toBe('NO_PAYMENT_CATEGORY');
		expect(db.select().from(budgetAssignments).all()).toHaveLength(0); void checking;
	});
	it('creates, updates and closes a promo balance', async () => {
		const { db, card } = seed();
		const created = await promosRoute({ request: req({ accountId: card, description: 'BT', originalAmount: 50000, expiresOn: '2027-03-31' }) } as never);
		expect(created.status).toBe(200); const { id } = await created.json();
		expect(db.select().from(promoBalances).where(eq(promoBalances.id, id)).get()).toMatchObject({ remainingAmount: 50000, aprBps: 0, closedAt: null });
		expect((await promoRoute({ request: req({ remainingAmount: 40000, aprBps: 299 }), params: { id: String(id) } } as never)).status).toBe(200);
		expect(db.select().from(promoBalances).where(eq(promoBalances.id, id)).get()).toMatchObject({ remainingAmount: 40000, aprBps: 299 });
		expect((await closeRoute({ params: { id: String(id) } } as never)).status).toBe(200);
		expect(db.select().from(promoBalances).where(eq(promoBalances.id, id)).get()!.closedAt).not.toBeNull();
	});
	it('rejects a promo above its original (409), a bad date (400), and an unknown id (404)', async () => {
		const { db, card } = seed();
		const created = await promosRoute({ request: req({ accountId: card, description: 'BT', originalAmount: 50000, expiresOn: '2027-03-31' }) } as never);
		const { id } = await created.json();
		const over = await promoRoute({ request: req({ remainingAmount: 50001 }), params: { id: String(id) } } as never);
		expect(over.status).toBe(409); expect((await over.json()).code).toBe('PROMO_REMAINING_OUT_OF_RANGE');
		expect((await promosRoute({ request: req({ accountId: card, description: 'x', originalAmount: 100, expiresOn: 'soon' }) } as never)).status).toBe(400);
		expect((await closeRoute({ params: { id: '999' } } as never)).status).toBe(404);
		expect(db.select().from(promoBalances).all()).toHaveLength(1);
	});
});
