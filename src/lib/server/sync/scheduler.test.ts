import { describe, it, expect, vi } from 'vitest';
import { startScheduler } from './scheduler';

vi.mock('node-cron', () => {
	const tasks: { expr: string; opts: unknown; destroy: () => void }[] = [];
	return {
		default: { schedule: (expr: string, _fn: unknown, opts: unknown) => { const t = { expr, opts, destroy: vi.fn() }; tasks.push(t); return t; } },
		__tasks: tasks
	};
});

describe('startScheduler', () => {
	it('schedules the two jobs in the configured zone and stops them', async () => {
		const cron = (await import('node-cron')) as unknown as { __tasks: { expr: string; opts: { timezone: string; noOverlap: boolean }; destroy: () => void }[] };
		const handle = startScheduler({
			db: {} as never,
			config: { syncHour: 3, balanceHour: 7, timeZone: 'America/New_York' } as never,
			deps: {} as never
		});
		expect(cron.__tasks.map((t) => t.expr)).toEqual(['0 3 * * *', '0 7 * * *']);
		expect(cron.__tasks[0].opts).toMatchObject({ timezone: 'America/New_York', noOverlap: true });
		handle.stop();
		expect(cron.__tasks.every((t) => (t.destroy as unknown as { mock: { calls: unknown[] } }).mock.calls.length === 1)).toBe(true);
	});
});
