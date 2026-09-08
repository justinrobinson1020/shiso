import { describe, it, expect } from 'vitest';
import { dueDatesBetween } from './schedule';

describe('dueDatesBetween', () => {
	it('monthly clamps to month end and stays inside the range', () => {
		expect(dueDatesBetween({ cadence: 'monthly', dueDay: 31 }, '2026-01-15', '2026-04-10'))
			.toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
	});
	it('semi-monthly emits both days', () => {
		expect(dueDatesBetween({ cadence: 'semi_monthly', dueDay: 1, dueDay2: 15 }, '2026-02-01', '2026-03-01'))
			.toEqual(['2026-02-01', '2026-02-15', '2026-03-01']);
	});
	it('every N weeks steps from the anchor', () => {
		expect(dueDatesBetween({ cadence: 'every_n_weeks', interval: 2, anchorDate: '2026-01-02' }, '2026-01-10', '2026-02-15'))
			.toEqual(['2026-01-16', '2026-01-30', '2026-02-13']);
	});
	it('yearly repeats the anchor month and day', () => {
		expect(dueDatesBetween({ cadence: 'yearly', anchorDate: '2024-06-20' }, '2026-01-01', '2027-12-31'))
			.toEqual(['2026-06-20', '2027-06-20']);
	});
});
