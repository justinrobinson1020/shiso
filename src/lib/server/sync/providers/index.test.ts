import { describe, it, expect } from 'vitest';
import { buildProviders, cronExpressions } from './index';
import type { Config } from '../../config';

const base: Config = {
	dbPath: 'x', backupDir: 'y', appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle', cadence: 'semi_monthly',
	syncHour: 3, balanceHour: 7, backupHour: 4, backupKeep: 30, plaid: { clientId: null, secret: null, env: 'sandbox' }, schedulerEnabled: true, plaidClientName: 'shiso'
};
describe('buildProviders', () => {
	it('registers plaid only when configured', () => {
		expect(Object.keys(buildProviders(base)).sort()).toEqual(['manual', 'simplefin']);
		expect(Object.keys(buildProviders({ ...base, plaid: { clientId: 'id', secret: 's', env: 'sandbox' } })).sort()).toEqual(['manual', 'plaid', 'simplefin']);
	});
	it('builds cron expressions from the configured hours', () => {
		expect(cronExpressions(base)).toEqual({ full: '0 3 * * *', balances: '0 7 * * *', backup: '0 4 * * *' });
	});
});
