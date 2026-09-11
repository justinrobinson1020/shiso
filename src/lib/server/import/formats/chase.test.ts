import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isChaseStatement, parseChaseStatement } from './chase';
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
describe('parseChaseStatement', () => {
	it('reads mask, dates, balances, and every activity row with the year from the closing date', () => {
		const f = parseChaseStatement(fx('chase-dec-jan.txt'));
		expect(isChaseStatement(fx('chase-dec-jan.txt'))).toBe(true);
		expect(f.format).toBe('chase'); expect(f.mask).toBe('1403');
		expect(f.statement).toEqual({ opensOn: '2024-12-03', closesOn: '2025-01-02', previousBalance: -231439, newBalance: -189966 });
		expect(f.balances).toEqual([{ asOf: '2025-01-02', current: -189966 }]);
		expect(f.rows.map((r) => [r.postedDate, r.amount, r.payeeRaw, r.providerCategory])).toEqual([
			['2024-12-17', 246661, 'Payment Thank You Bill Pay Service', 'PAYMENTS AND OTHER CREDITS'],
			['2024-12-05', -9526, 'UBER *EATS HELP.UBER.COM CA', 'PURCHASE'],
			['2024-12-05', -9526, 'UBER *EATS HELP.UBER.COM CA', 'PURCHASE'],
			['2024-12-28', -36368, 'TST*KYOJIN SUSHI Washington DC', 'PURCHASE'],
			['2025-01-01', -149768, 'COSTCO WHSE #1120 WASHINGTON DC', 'PURCHASE']
		]);
		expect(f.rows.every((r) => r.transactedAt === null && r.memo === null && r.referenceId === null)).toBe(true);
		// the fixture reconciles: previous + Σ rows = new
		expect(f.statement!.previousBalance + f.rows.reduce((s, r) => s + r.amount, 0)).toBe(f.statement!.newBalance);
	});
	it('treats a statement with no activity block as zero rows', () => {
		const f = parseChaseStatement(fx('chase-empty.txt'));
		expect(f.rows).toEqual([]); expect(f.mask).toBe('0856');
		expect(f.statement).toEqual({ opensOn: '2024-12-18', closesOn: '2025-01-17', previousBalance: 0, newBalance: 0 });
		expect(f.balances).toEqual([{ asOf: '2025-01-17', current: 0 }]);
	});
	it('fails loudly without an opening/closing date', () => { expect(() => parseChaseStatement('chase.com\nnothing here')).toThrow(/Opening\/Closing/); });
});
