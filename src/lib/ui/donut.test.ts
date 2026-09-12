import { describe, it, expect } from 'vitest';
import { donutSlices } from './donut';
const rows = [
	{ id: 1, name: 'Dining', amount: 5000 }, { id: 2, name: 'Groceries', amount: 3000 }, { id: 3, name: 'Refund', amount: -800 },
	{ id: 4, name: 'Fees', amount: 0 }, { id: 5, name: 'Travel', amount: 2000 }
];
describe('donutSlices', () => {
	it('keeps positive amounts only, largest first, with shares summing to one', () => {
		const s = donutSlices(rows);
		expect(s.map((x) => [x.name, x.amount])).toEqual([['Dining', 5000], ['Groceries', 3000], ['Travel', 2000]]);
		expect(s.reduce((t, x) => t + x.share, 0)).toBeCloseTo(1, 10);
		expect(s[0].share).toBeCloseTo(0.5, 10);
		expect(s.every((x) => x.path.startsWith('M') && x.path.endsWith('Z'))).toBe(true);
		expect(new Set(s.map((x) => x.color)).size).toBe(3);
	});
	it('folds everything beyond the top max−1 into Other', () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `C${i + 1}`, amount: (12 - i) * 100 }));
		const s = donutSlices(many, { max: 8 });
		expect(s).toHaveLength(8);
		expect(s[7]).toMatchObject({ id: null, name: 'Other', amount: (5 + 4 + 3 + 2 + 1) * 100 });
		expect(donutSlices(many.slice(0, 8), { max: 8 })).toHaveLength(8);   // exactly max: no Other slice
	});
	it('returns nothing when there is no positive spending, and renders a lone slice as a near-full ring', () => {
		expect(donutSlices([{ id: 1, name: 'x', amount: -5 }])).toEqual([]);
		const one = donutSlices([{ id: 1, name: 'Only', amount: 100 }]);
		expect(one).toHaveLength(1); expect(one[0].share).toBe(1); expect(one[0].path).toContain(' 1 1 ');
	});
});
