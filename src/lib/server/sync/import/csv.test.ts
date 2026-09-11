import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase, type Db } from '../../db';
import { accounts, connections, transactions } from '../../db/schema';
import { seedDefaultCategories } from '../../ledger/categories';
import { importCsv } from './csv';

const CSV = `Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By
09/01/2026,09/02/2026,APPLE.COM/BILL 866-712-7753 CA,Apple,Other,Purchase,10.59,Justin Robinson
09/03/2026,09/04/2026,"WHOLE FOODS, MKT 10245",Whole Foods,Grocery,Purchase,84.12,Justin Robinson
09/03/2026,09/04/2026,"WHOLE FOODS, MKT 10245",Whole Foods,Grocery,Purchase,84.12,Justin Robinson
09/05/2026,09/05/2026,ACH DEPOSIT INTERNET TRANSFER,ACH DEPOSIT INTERNET TRANSFER,Payment,Payment,-61.00,Justin Robinson
`;

describe('importCsv', () => {
	let db: Db; let card: number;
	beforeEach(() => {
		db = openMemoryDatabase().db;
		seedDefaultCategories(db);
		const c = db.insert(connections).values({ provider: 'manual', institutionName: 'Apple' }).returning({ id: connections.id }).get().id;
		card = db.insert(accounts).values({ connectionId: c, externalId: 'apple', name: 'Apple Card', type: 'credit', onBudget: true, isDebt: true }).returning({ id: accounts.id }).get().id;
	});
	it('creates rows once, distinguishes identical lines by ordinal, and is idempotent', () => {
		const r1 = importCsv(db, card, CSV, { cadence: 'semi_monthly', todayIso: '2026-09-08' });
		expect(r1).toMatchObject({ created: 4, duplicates: 0 });
		expect(r1.ids.length).toBe(4);
		const r2 = importCsv(db, card, CSV, { cadence: 'semi_monthly', todayIso: '2026-09-08' });
		expect(r2).toMatchObject({ created: 0, duplicates: 4 });
		const rows = db.select().from(transactions).all();
		expect(rows.length).toBe(4);
		expect(rows.every((t) => t.source === 'import' && t.processedAt === null)).toBe(true);
	});
	it('normalises descriptions differing only in case or whitespace', () => {
		const csvNormalize = `Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By
09/03/2026,09/04/2026,"WHOLE FOODS, MKT 10245",Whole Foods,Grocery,Purchase,84.12,Justin Robinson
09/03/2026,09/04/2026,"whole foods,  mkt 10245",Whole Foods,Grocery,Purchase,84.12,Justin Robinson
`;
		const r1 = importCsv(db, card, csvNormalize, { cadence: 'semi_monthly', todayIso: '2026-09-08' });
		expect(r1).toMatchObject({ created: 2, duplicates: 0 });
		expect(r1.ids.length).toBe(2);
		const r2 = importCsv(db, card, csvNormalize, { cadence: 'semi_monthly', todayIso: '2026-09-08' });
		expect(r2).toMatchObject({ created: 0, duplicates: 2 });
	});
});
