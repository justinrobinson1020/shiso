import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { openMemoryDatabase, type Db } from '../db';
import { accounts, billOccurrences, billOccurrenceTransactions, connections, incomeOccurrences } from '../db/schema';
import { seedDefaultCategories, createGroup, createCategory, systemCategoryId } from '../ledger/categories';
import { ensurePeriods } from '../budget/periods';
import { createTransaction, linkTransfer, softDelete, getTransaction } from '../ledger/transactions';
import { createBill, createIncomeSource } from './bills';
import { generateOccurrences } from './schedule';
import { matchBillOccurrences, matchIncomeOccurrences, markOverdue, markOccurrencePaid, unmarkOccurrence, skipOccurrence, unwindRemovedTransactions } from './matching';

let db: Db; let chk: number; let card: number; let rentCat: number; let cardEnv: number;
const TODAY = '2026-09-08';
const mk = (accountId: number, ext: string, amount: number, postedDate: string, payeeRaw: string) =>
	createTransaction(db, { accountId, externalId: ext, postedDate, amount, payeeRaw, source: 'sync' });
const occ = () => db.select().from(billOccurrences).all().sort((a, b) => a.dueDate.localeCompare(b.dueDate));

beforeEach(() => {
	db = openMemoryDatabase().db;
	seedDefaultCategories(db);
	ensurePeriods(db, 'semi_monthly', '2026-01-01', '2026-12-31');
	const c = db.insert(connections).values({ provider: 'manual', institutionName: 'T' }).returning({ id: connections.id }).get().id;
	chk = db.insert(accounts).values({ connectionId: c, externalId: 'k', name: 'Chk', type: 'checking', onBudget: true, isDebt: false }).returning({ id: accounts.id }).get().id;
	card = db.insert(accounts).values({ connectionId: c, externalId: 'c', name: 'Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	rentCat = createCategory(db, { groupId: createGroup(db, 'Bills'), name: 'Rent', kind: 'bill' });
	cardEnv = createCategory(db, { groupId: createGroup(db, 'Debt'), name: 'Card', kind: 'debt_payment', accountId: card });
});

describe('bill matching', () => {
	it('matches a bill by payee and amount within tolerance and marks it paid', () => {
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 225000, toleranceAbs: 100, cadence: 'monthly', dueDay: 1, matchPattern: 'landlord' });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		const t = mk(chk, 'r', -225000, '2026-08-30', 'LANDLORD LLC');
		expect(matchBillOccurrences(db, TODAY)).toEqual({ matched: 1, tied: 0 });
		const o = occ()[0];
		expect(o.status).toBe('paid');
		expect(o.paidAmount).toBe(225000);
		expect(o.markedBy).toBe('auto');
		expect(db.select().from(billOccurrenceTransactions).all()).toEqual([{ billOccurrenceId: o.id, transactionId: t }]);
		expect(getTransaction(db, t).splits[0].categoryId).toBe(rentCat);
	});
	it('a debt bill sums every transfer to the linked card in the window and records the extra', () => {
		createBill(db, { name: 'Card', categoryId: cardEnv, payFromAccountId: chk, expectedAmount: 3500, cadence: 'monthly', dueDay: 15, linkedDebtAccountId: card });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		const min = mk(chk, 'm', -3500, '2026-09-02', 'CHASE PAYMENT'); const minPeer = mk(card, 'mp', 3500, '2026-09-02', 'PAYMENT');
		const extra = mk(chk, 'e', -66700, '2026-09-05', 'CHASE PAYMENT'); const extraPeer = mk(card, 'ep', 66700, '2026-09-05', 'PAYMENT');
		linkTransfer(db, min, minPeer); linkTransfer(db, extra, extraPeer);
		matchBillOccurrences(db, TODAY);
		const o = occ().find((x) => x.dueDate === '2026-09-15')!;
		expect(o.status).toBe('paid');
		expect(o.paidAmount).toBe(70200);
		expect(o.extraAmount).toBe(66700);
	});
	it('a debt occurrence settled by the minimum still accumulates later transfers to the card', () => {
		createBill(db, { name: 'Card', categoryId: cardEnv, payFromAccountId: chk, expectedAmount: 3500, cadence: 'monthly', dueDay: 15, linkedDebtAccountId: card });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		const min = mk(chk, 'm', -3500, '2026-09-02', 'CHASE PAYMENT'); const minPeer = mk(card, 'mp', 3500, '2026-09-02', 'PAYMENT');
		linkTransfer(db, min, minPeer);
		matchBillOccurrences(db, TODAY);
		const first = occ().find((x) => x.dueDate === '2026-09-15')!;
		expect(first).toMatchObject({ status: 'paid', paidAmount: 3500, extraAmount: 0 });

		// the user pays the statement balance a few days later, on the same card, inside the same window
		const extra = mk(chk, 'e', -120500, '2026-09-05', 'CHASE PAYMENT'); const extraPeer = mk(card, 'ep', 120500, '2026-09-05', 'PAYMENT');
		linkTransfer(db, extra, extraPeer);
		matchBillOccurrences(db, TODAY);
		const o = occ().find((x) => x.dueDate === '2026-09-15')!;
		expect(o).toMatchObject({ status: 'paid', paidAmount: 124000, extraAmount: 120500 });
		expect(db.select().from(billOccurrenceTransactions).where(eq(billOccurrenceTransactions.billOccurrenceId, o.id)).all().map((r) => r.transactionId).sort((a, b) => a - b))
			.toEqual([min, extra].sort((a, b) => a - b));

		// re-running with nothing new is a no-op, not a double count
		matchBillOccurrences(db, TODAY);
		expect(occ().find((x) => x.dueDate === '2026-09-15')!).toMatchObject({ paidAmount: 124000, extraAmount: 120500 });
	});
	it('a paid non-debt occurrence does not claim a second matching transaction', () => {
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 225000, toleranceAbs: 100, cadence: 'monthly', dueDay: 1, matchPattern: 'landlord' });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		const t1 = mk(chk, 'r1', -225000, '2026-08-30', 'LANDLORD LLC');
		matchBillOccurrences(db, TODAY);
		const sep = occ().find((x) => x.dueDate === '2026-09-01')!;
		expect(sep).toMatchObject({ status: 'paid', paidAmount: 225000 });

		mk(chk, 'r2', -225000, '2026-08-31', 'LANDLORD LLC');
		expect(matchBillOccurrences(db, TODAY).matched).toBe(0);
		const after = occ().find((x) => x.dueDate === '2026-09-01')!;
		expect(after.paidAmount).toBe(225000);
		expect(db.select().from(billOccurrenceTransactions).where(eq(billOccurrenceTransactions.billOccurrenceId, after.id)).all())
			.toEqual([{ billOccurrenceId: after.id, transactionId: t1 }]);
	});
	it('the earlier occurrence claims a payment inside two overlapping windows', () => {
		createBill(db, { name: 'Card', categoryId: cardEnv, payFromAccountId: chk, expectedAmount: 3500, cadence: 'monthly', dueDay: 15, linkedDebtAccountId: card });
		generateOccurrences(db, { todayIso: '2026-09-20', cadence: 'semi_monthly', graceDays: 3 }); // Sep 15 and Oct 15; windows Aug 21-Sep 18 and Sep 20-Oct 18
		db.update(billOccurrences).set({ windowEnd: '2026-09-25' }).where(eq(billOccurrences.dueDate, '2026-09-15')).run(); // force overlap
		const p = mk(chk, 'p', -3500, '2026-09-22', 'PAYMENT'); const pp = mk(card, 'pp', 3500, '2026-09-22', 'PAYMENT');
		linkTransfer(db, p, pp);
		matchBillOccurrences(db, '2026-09-20');
		const [sep, oct] = occ();
		expect(sep.status).toBe('paid');
		expect(oct.status).toBe('pending');
	});
	it('a tie flags the occurrence and links nothing', () => {
		createBill(db, { name: 'Water', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 9773, toleranceAbs: 500, cadence: 'monthly', dueDay: 12, matchPattern: 'water' });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		mk(chk, 'a', -9773, '2026-09-10', 'CITY WATER'); mk(chk, 'b', -9773, '2026-09-10', 'CITY WATER');
		expect(matchBillOccurrences(db, TODAY)).toEqual({ matched: 0, tied: 1 });
		expect(occ().find((o) => o.dueDate === '2026-09-12')!.needsReview).toBe(true);
	});
	it('marks overdue after grace and skips manual marks', () => {
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 1, cadence: 'monthly', dueDay: 1 });
		createBill(db, { name: 'Gym', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 1, cadence: 'monthly', dueDay: 28 });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		// occurrences by due date: Gym Aug 28, Rent Sep 1, Gym Sep 28; the first two are past Sep 5 (today − grace)
		expect(occ().map((o) => o.dueDate)).toEqual(['2026-08-28', '2026-09-01', '2026-09-28']);
		expect(markOverdue(db, TODAY, 3)).toBe(2);
		expect(occ()[1].status).toBe('overdue');
		markOccurrencePaid(db, occ()[1].id, { amount: 1 });
		expect(occ()[1]).toMatchObject({ status: 'paid', markedBy: 'manual', paidAmount: 1 });
		unmarkOccurrence(db, occ()[1].id);
		expect(occ()[1]).toMatchObject({ status: 'pending', markedBy: 'manual', paidAmount: 0 });
		skipOccurrence(db, occ()[2].id);
		expect(occ()[2].status).toBe('skipped');
		mk(chk, 'x', -1, '2026-09-01', 'ANY'); // inside Rent's window only, and Rent is manually marked
		expect(matchBillOccurrences(db, TODAY).matched).toBe(0);
		expect(occ()[1].status).toBe('pending');
	});
	it('unwinds an auto match when its transaction is removed', () => {
		createBill(db, { name: 'Rent', categoryId: rentCat, payFromAccountId: chk, expectedAmount: 225000, cadence: 'monthly', dueDay: 1, matchPattern: 'landlord' });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		const t = mk(chk, 'r', -225000, '2026-08-30', 'LANDLORD LLC');
		matchBillOccurrences(db, TODAY);
		softDelete(db, t, 'provider_removed');
		expect(unwindRemovedTransactions(db, [t])).toEqual({ reopened: 1 });
		expect(occ()[0]).toMatchObject({ status: 'pending', paidAmount: 0, markedBy: null });
		expect(db.select().from(billOccurrenceTransactions).all()).toEqual([]);
	});
});

describe('income matching', () => {
	it('matches a deposit and records the received amount', () => {
		createIncomeSource(db, { name: 'Salary', categoryId: systemCategoryId(db, 'income'), depositAccountId: chk, expectedAmount: 319200, tolerancePct: 10, cadence: 'semi_monthly', dueDay: 15, dueDay2: 30, matchPattern: 'employer' });
		generateOccurrences(db, { todayIso: TODAY, cadence: 'semi_monthly', graceDays: 3 });
		const t = mk(chk, 'pay', 310000, '2026-08-29', 'EMPLOYER INC PAYROLL');
		expect(matchIncomeOccurrences(db, TODAY)).toEqual({ matched: 1 });
		const o = db.select().from(incomeOccurrences).all().find((x) => x.dueDate === '2026-08-30')!;
		expect(o).toMatchObject({ status: 'paid', receivedAmount: 310000, transactionId: t, markedBy: 'auto' });
		expect(getTransaction(db, t).splits[0].categoryId).toBe(systemCategoryId(db, 'income'));
	});
});
