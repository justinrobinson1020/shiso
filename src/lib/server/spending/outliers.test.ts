import { describe, it, expect } from 'vitest';
import { findOutliers, type Charge } from './outliers';

const charge = (o: Partial<Charge> & { id: number; amount: number }): Charge => ({ date: '2026-08-01', payee: 'Whole Foods', categoryId: 1, categoryName: 'Groceries', ...o });
const groceries = Array.from({ length: 10 }, (_, i) => charge({ id: 100 + i, amount: 8000 + (i % 3) * 500, payee: i % 2 ? 'Whole Foods' : 'Trader Joes' }));

describe('findOutliers (P3 §3.2)', () => {
	it('flags a charge far above the category median, with its multiple', () => {
		const out = findOutliers([charge({ id: 1, amount: 50000, date: '2026-09-03' })], groceries);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ id: 1, reason: 'category', usual: 8500, multiple: 5.9 });
	});
	it('flags by merchant when the category is noisy but the merchant is stable', () => {
		const noisyCat = Array.from({ length: 10 }, (_, i) => charge({ id: 200 + i, amount: [1000, 90000, 3000, 45000, 2000, 60000, 7000, 30000, 1500, 80000][i], payee: `P${i}`, categoryId: 2, categoryName: 'Shopping' }));
		// the merchant's history sits in another category (recategorised since), so only the merchant test can fire
		const netflix = Array.from({ length: 8 }, (_, i) => charge({ id: 300 + i, amount: 1599, payee: 'Netflix', categoryId: 3, categoryName: 'Streaming' }));
		const out = findOutliers([charge({ id: 2, amount: 3200, payee: 'Netflix', categoryId: 2, categoryName: 'Shopping' })], [...noisyCat, ...netflix]);
		expect(out).toHaveLength(1); expect(out[0]).toMatchObject({ reason: 'merchant', usual: 1599, multiple: 2 });
	});
	it('needs at least eight history rows and ignores charges under the floor', () => {
		expect(findOutliers([charge({ id: 1, amount: 50000 })], groceries.slice(0, 7))).toEqual([]);
		expect(findOutliers([charge({ id: 1, amount: 2400 })], Array.from({ length: 10 }, (_, i) => charge({ id: 400 + i, amount: 300 })))).toEqual([]);
	});
	it('does not flag an ordinary charge', () => {
		expect(findOutliers([charge({ id: 1, amount: 9000 })], groceries)).toEqual([]);
	});
});
