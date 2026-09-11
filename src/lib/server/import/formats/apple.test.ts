import { describe, it, expect } from 'vitest';
import { parseAppleCardCsv } from './apple';

const CSV = `Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By
09/01/2026,09/02/2026,APPLE.COM/BILL 866-712-7753 CA,Apple,Other,Purchase,10.59,Justin Robinson
09/03/2026,09/04/2026,"WHOLE FOODS, MKT 10245",Whole Foods,Grocery,Purchase,84.12,Justin Robinson
09/03/2026,09/04/2026,"WHOLE FOODS, MKT 10245",Whole Foods,Grocery,Purchase,84.12,Justin Robinson
09/05/2026,09/05/2026,ACH DEPOSIT INTERNET TRANSFER,ACH DEPOSIT INTERNET TRANSFER,Payment,Payment,-61.00,Justin Robinson
`;

describe('parseAppleCardCsv', () => {
	it('maps rows with the sign convention and ISO dates', () => {
		const result = parseAppleCardCsv(CSV);
		expect(result.rows.length).toBe(4);
		expect(result.rows[0]).toEqual({ postedDate: '2026-09-02', transactedAt: '2026-09-01T00:00:00Z', amount: -1059, payeeRaw: 'Apple', memo: 'APPLE.COM/BILL 866-712-7753 CA', providerCategory: 'Other', referenceId: null });
		expect(result.rows[3]).toMatchObject({ amount: 6100, payeeRaw: 'ACH DEPOSIT INTERNET TRANSFER', memo: null, providerCategory: 'Payment', referenceId: null });
		expect(result).toEqual({ format: 'apple', mask: null, statement: null, balances: [], rows: result.rows });
	});
	it('rejects an unknown header', () => {
		expect(() => parseAppleCardCsv('Date,Amount\n1,2')).toThrowError(/header/);
	});
});
