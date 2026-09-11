import { describe, it, expect } from 'vitest';
import { usDateToIso, statementRowDate, dollars } from './dates';
describe('dates', () => {
	it('parses US dates with 2- or 4-digit years and single-digit parts', () => {
		expect(usDateToIso('9/8/2026')).toBe('2026-09-08'); expect(usDateToIso('09/08/2026')).toBe('2026-09-08'); expect(usDateToIso('10/21/25')).toBe('2025-10-21');
		expect(() => usDateToIso('2026-09-08')).toThrow(/date/);
	});
	it('dates statement rows from the closing date with December wraparound', () => {
		expect(statementRowDate('12/05', '2025-01-02')).toBe('2024-12-05'); expect(statementRowDate('01/01', '2025-01-02')).toBe('2025-01-01'); expect(statementRowDate('08/02', '2026-08-02')).toBe('2026-08-02');
	});
	it('reads printed dollar amounts as cents', () => {
		expect(dollars('-$1,234.56')).toBe(-123456); expect(dollars('1,234.56')).toBe(123456); expect(dollars('$0.00')).toBe(0); expect(dollars('-2,466.61')).toBe(-246661);
	});
	it('rounds fractional amounts to 2 decimal places', () => {
		expect(dollars('-60.00000')).toBe(-6000); expect(dollars('2168.92000')).toBe(216892); expect(dollars('1.005')).toBe(101); expect(dollars('-0.004')).toBe(0); expect(dollars('9.999')).toBe(1000);
	});
});
