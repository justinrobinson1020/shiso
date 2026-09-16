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
	it('lands semi-monthly closes on the settlement day when settleBusinessDays is set', () => {
		expect(dueDatesBetween({ cadence: 'semi_monthly', dueDay: 15, dueDay2: 31, settleBusinessDays: 2 }, '2026-08-01', '2026-10-05'))
			.toEqual(['2026-08-04', '2026-08-19', '2026-09-02', '2026-09-17', '2026-10-02']);
	});
	it('includes a nominal date before the range whose landing falls inside it', () => {
		expect(dueDatesBetween({ cadence: 'semi_monthly', dueDay: 15, dueDay2: 31, settleBusinessDays: 2 }, '2026-09-01', '2026-09-15')).toEqual(['2026-09-02']);
		expect(dueDatesBetween({ cadence: 'semi_monthly', dueDay: 15, dueDay2: 31, settleBusinessDays: 2 }, '2026-09-03', '2026-09-15')).toEqual([]);
	});
	it('treats null or zero settleBusinessDays as the nominal date', () => {
		expect(dueDatesBetween({ cadence: 'monthly', dueDay: 15, settleBusinessDays: 0 }, '2026-08-01', '2026-08-31')).toEqual(['2026-08-15']);
		expect(dueDatesBetween({ cadence: 'monthly', dueDay: 15, settleBusinessDays: null }, '2026-08-01', '2026-08-31')).toEqual(['2026-08-15']);
	});
	it('treats a zero or missing interval as one week', () => {
		expect(dueDatesBetween({ cadence: 'every_n_weeks', interval: 0, anchorDate: '2026-01-02' }, '2026-01-01', '2026-01-20')).toEqual(['2026-01-02', '2026-01-09', '2026-01-16']);
	});
});
