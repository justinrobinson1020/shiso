import { describe, it, expect } from 'vitest';
import { median, mad, robustScore } from './stats';

describe('stats', () => {
	it('median of odd and even lists, empty is zero', () => {
		expect(median([5, 1, 3])).toBe(3); expect(median([4, 1, 3, 2])).toBe(3); expect(median([])).toBe(0);
	});
	it('MAD is the median absolute deviation', () => {
		expect(mad([1, 2, 3, 4, 100])).toBe(1);
	});
	it('robust score uses 1.4826 × MAD, or a tenth of the median when MAD is zero', () => {
		const r = robustScore(200, [100, 100, 100, 100]);
		expect(r.median).toBe(100); expect(r.scale).toBe(10); expect(r.score).toBe(10);
		const s = robustScore(4000, [1000, 1200, 900, 1100, 1000]);
		expect(s.median).toBe(1000); expect(s.scale).toBeCloseTo(148.26); expect(s.score).toBeCloseTo(20.23, 1);
		expect(robustScore(5, []).score).toBe(Infinity); expect(robustScore(0, []).score).toBe(0);
	});
});
