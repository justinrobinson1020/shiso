import { describe, it, expect } from 'vitest';
import { parseNasaFcuCsv } from './nasa-fcu';
import { ImportError } from './types';
const HEAD = `"Transaction ID","Posting Date","Effective Date","Transaction Type","Posting Status","Amount","Check Number","Reference Number","Description","Transaction Category","Type","Balance","Memo","Extended Description"`;
const CSV = `${HEAD}
"20260902 1","9/2/2026","9/2/2026","Debit","Posted","-21.20000","","1","Transfer to PayPal","Transfers","ACH","2168.92000","","PAYPAL TYPE: PURCHASE"
"20260831 2","8/31/2026","8/30/2026","Credit","Posted","1500.00000","","2","Payroll","Paychecks/Salary","ACH","2190.12000","","Payroll"
"20260830 3","8/30/2026","8/30/2026","Debit","Posted","-60.00000","","3","Withdrawal Zelle","","","690.12000","","Withdrawal Zelle"
"20260815 4","8/15/2026","8/15/2026","Debit","Posted","-10.00000","","4","Coffee","Restaurants & Dining","Card","750.12000","","Coffee"
`;
describe('parseNasaFcuCsv', () => {
	it('reads signed amounts, stable ids, memo only when it adds something, and month-end balances', () => {
		const f = parseNasaFcuCsv(CSV);
		expect(f).toMatchObject({ format: 'nasa_fcu', mask: null, statement: null });
		expect(f.rows.map((r) => [r.postedDate, r.transactedAt, r.amount, r.payeeRaw, r.memo, r.providerCategory, r.referenceId])).toEqual([
			['2026-08-15', '2026-08-15T00:00:00Z', -1000, 'Coffee', null, 'Restaurants & Dining', 'nasa:20260815 4'],
			['2026-08-30', '2026-08-30T00:00:00Z', -6000, 'Withdrawal Zelle', null, null, 'nasa:20260830 3'],
			['2026-08-31', '2026-08-30T00:00:00Z', 150000, 'Payroll', null, 'Paychecks/Salary', 'nasa:20260831 2'],
			['2026-09-02', '2026-09-02T00:00:00Z', -2120, 'Transfer to PayPal', 'PAYPAL TYPE: PURCHASE', 'Transfers', 'nasa:20260902 1']
		]);
		expect(f.balances).toEqual([{ asOf: '2026-08-31', current: 219012 }, { asOf: '2026-09-02', current: 216892 }]);
	});
	it('rejects a running-balance break as a reconciliation error naming the row', () => {
		const broken = CSV.replace('"690.12000"', '"690.13000"');
		expect(() => parseNasaFcuCsv(broken)).toThrow(ImportError);
		expect(() => parseNasaFcuCsv(broken)).toThrow(/8\/31\/2026.*Payroll/);
	});
	it('rejects an unknown header', () => { expect(() => parseNasaFcuCsv('Date,Amount\n1,2')).toThrow(/header/); });
});
