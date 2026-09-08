import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { load } from './+page.server';

let dir: string;
const cfg = (d: string) => ({
	dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle',
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, plaid: { clientId: null, secret: null, env: 'sandbox' as const },
	schedulerEnabled: false, plaidClientName: 'shiso'
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'shiso-accounts-page-'));
	const c = cfg(dir); setConfig(c); startup(c, '2026-09-08');
});
afterEach(() => { resetForTests(); rmSync(dir, { recursive: true, force: true }); });

describe('accounts page load', () => {
	it('reports plaid as not configured and returns today', async () => {
		const data = (await load({} as never)) as { view: { plaidConfigured: boolean }; today: string };
		expect(data.view.plaidConfigured).toBe(false);
		expect(data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
