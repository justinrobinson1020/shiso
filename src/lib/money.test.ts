import { describe, it, expect } from 'vitest';
import { decimalToCents, formatCents } from './money';

describe('decimalToCents', () => {
	it('parses plain decimals', () => {
		expect(decimalToCents('12.34')).toBe(1234);
		expect(decimalToCents('-12.34')).toBe(-1234);
		expect(decimalToCents('0.5')).toBe(50);
		expect(decimalToCents('7')).toBe(700);
	});
	it('parses numbers without float drift', () => {
		expect(decimalToCents(0.1 + 0.2)).toBe(30);
		expect(decimalToCents(1234.56)).toBe(123456);
		expect(decimalToCents(1.005)).toBe(101);
		expect(decimalToCents(-1.005)).toBe(-101);
		expect(decimalToCents(2.675)).toBe(268);
		expect(() => decimalToCents(NaN)).toThrow();
	});
	it('strips thousands separators and currency symbols', () => {
		expect(decimalToCents('$1,234.50')).toBe(123450);
		expect(decimalToCents('($1,234.50)')).toBe(-123450);
	});
	it('rejects more than two decimals', () => {
		expect(() => decimalToCents('1.234')).toThrow();
	});
	it('rejects garbage', () => {
		expect(() => decimalToCents('abc')).toThrow();
	});
});

describe('formatCents', () => {
	it('formats with sign and grouping', () => {
		expect(formatCents(123456)).toBe('$1,234.56');
		expect(formatCents(-123456)).toBe('-$1,234.56');
		expect(formatCents(5)).toBe('$0.05');
		expect(formatCents(0)).toBe('$0.00');
	});
});
