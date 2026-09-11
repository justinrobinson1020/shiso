import { describe, it, expect } from 'vitest';
import { parseCapitalOneCsv } from './capital-one';
const CSV = `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-09-06,2026-09-07,2414,PRISMADICAI,Merchandise,50.00,
2026-08-21,2026-08-21,2414,CAPITAL ONE MOBILE PYMT,Payment/Credit,,72.00
`;
describe('parseCapitalOneCsv', () => {
	it('maps debit and credit columns to signed cents, oldest first, with the card mask', () => {
		const f = parseCapitalOneCsv(CSV);
		expect(f).toMatchObject({ format: 'capital_one', mask: '2414', statement: null, balances: [] });
		expect(f.rows).toEqual([
			{ postedDate: '2026-08-21', transactedAt: '2026-08-21T00:00:00Z', amount: 7200, payeeRaw: 'CAPITAL ONE MOBILE PYMT', memo: null, providerCategory: 'Payment/Credit', referenceId: null },
			{ postedDate: '2026-09-07', transactedAt: '2026-09-06T00:00:00Z', amount: -5000, payeeRaw: 'PRISMADICAI', memo: null, providerCategory: 'Merchandise', referenceId: null }
		]);
	});
	it('rejects an unknown header', () => { expect(() => parseCapitalOneCsv('Date,Amount\n1,2')).toThrow(/header/); });
});
