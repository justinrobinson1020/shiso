import { describe, it, expect } from 'vitest';
import { loadConfig } from './config';

const good = {
	SHISO_DB_PATH: '/tmp/x.db', SHISO_BACKUP_DIR: '/tmp/b',
	SHISO_APP_KEY: 'a'.repeat(44)
};

describe('loadConfig', () => {
	it('names the first missing variable', () => {
		expect(() => loadConfig({})).toThrowError(/SHISO_DB_PATH/);
		expect(() => loadConfig({ SHISO_DB_PATH: 'x' })).toThrowError(/SHISO_BACKUP_DIR/);
	});
	it('rejects a short app key', () => {
		expect(() => loadConfig({ ...good, SHISO_APP_KEY: 'short' })).toThrowError(/SHISO_APP_KEY/);
	});
	it('applies defaults', () => {
		const c = loadConfig(good);
		expect(c.cadence).toBe('semi_monthly');
		expect(c.syncHour).toBe(3);
		expect(c.plaid.env).toBe('sandbox');
		expect(c.timeZone).toBe('America/New_York');
		expect(c.migrationsDir.endsWith('drizzle')).toBe(true);
	});
	it('rejects an unknown time zone', () => {
		expect(() => loadConfig({ ...good, SHISO_TZ: 'Mars/Olympus' })).toThrowError(/SHISO_TZ/);
	});
	it('rejects a malformed sync hour by name', () => {
		expect(() => loadConfig({ ...good, SHISO_SYNC_HOUR: 'noon' })).toThrowError(/SHISO_SYNC_HOUR/);
		expect(() => loadConfig({ ...good, SHISO_BALANCE_HOUR: '24' })).toThrowError(/SHISO_BALANCE_HOUR/);
	});
});
