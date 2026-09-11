import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isSynchronyStatement, parseSynchronyStatement } from './synchrony';
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const sum = (f: { rows: { amount: number }[] }) => f.rows.reduce((s, r) => s + r.amount, 0);
describe('parseSynchronyStatement', () => {
	it('reads the Amazon Store Card layout: mask, dated balances, reference ids, zero interest row dropped', () => {
		const text = fx('synchrony-amazon.txt'); expect(isSynchronyStatement(text)).toBe(true);
		const f = parseSynchronyStatement(text);
		expect(f.format).toBe('synchrony'); expect(f.mask).toBe('7672');
		expect(f.statement).toEqual({ opensOn: '2025-10-23', closesOn: '2025-11-20', previousBalance: -85725, newBalance: -56864 });
		expect(f.balances).toEqual([{ asOf: '2025-11-20', current: -56864 }]);
		expect(f.rows.map((r) => [r.postedDate, r.amount, r.payeeRaw, r.providerCategory, r.referenceId, r.memo])).toEqual([
			['2025-11-04', 28861, 'ONLINE PYMT-THANK YOU ATLANTA GA', 'PAYMENTS', 'syf:P9342009M00XS6H11', null],
			['2025-10-25', 2648, 'AMAZON RETAIL SEATTLE WA', 'PAYMENTS', 'syf:P9342009BEHM6S9PZ', null],
			['2025-10-21', -2648, 'AMAZON RETAIL SEATTLE WA', 'PURCHASES', 'syf:P93420097EHM6S9PT', null]
		]);
		expect(f.statement!.previousBalance + sum(f)).toBe(f.statement!.newBalance);
	});
	it('reads the PayPal Credit layout: full dates, posting date, plan type stripped, promo text as memo, fee row', () => {
		const text = fx('synchrony-paypal.txt'); expect(isSynchronyStatement(text)).toBe(true);
		const f = parseSynchronyStatement(text);
		expect(f.mask).toBe('8182');
		expect(f.statement).toEqual({ opensOn: '2025-09-27', closesOn: '2025-10-27', previousBalance: -168127, newBalance: -397729 });
		expect(f.rows.map((r) => [r.postedDate, r.transactedAt, r.amount, r.payeeRaw, r.providerCategory, r.referenceId, r.memo])).toEqual([
			['2025-10-21', '2025-10-21T00:00:00Z', 78937, 'Online Payment Thank You', 'PAYMENTS', 'syf:P928300970122QF2N', null],
			['2025-10-03', '2025-10-01T00:00:00Z', -39899, 'CHANGWANGWE', 'PURCHASES', 'syf:P9283008KEHM6QAA9', 'No Interest If Paid In Full'],
			['2025-10-08', '2025-10-08T00:00:00Z', -268440, 'TICKETMASTER', 'PURCHASES', 'syf:P9283008SEHM6B0MN', 'No Interest If Paid In Full'],
			['2025-10-27', '2025-10-27T00:00:00Z', -200, 'Minimum Interest Charge', 'FEES', null, null]
		]);
		expect(f.statement!.previousBalance + sum(f)).toBe(f.statement!.newBalance);
	});
});
