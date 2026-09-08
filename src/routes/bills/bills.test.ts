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
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, backupHour: 4, backupKeep: 30, plaid: { clientId: null, secret: null, env: 'sandbox' as const },
	schedulerEnabled: false, plaidClientName: 'shiso'
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'shiso-routes-'));
	const c = cfg(dir); setConfig(c); startup(c, '2026-09-08');
});
afterEach(() => { resetForTests(); rmSync(dir, { recursive: true, force: true }); });

describe('bills page load', () => {
	it('loads the bills view and category tree', async () => {
		const d = (await load({} as never)) as { view: { bills: unknown[] }; tree: { groups: unknown[] } };
		expect(Array.isArray(d.view.bills)).toBe(true);
		expect(d.tree.groups.length).toBeGreaterThan(0);
	});
});
