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
	dir = mkdtempSync(join(tmpdir(), 'shiso-routes-'));
	const c = cfg(dir); setConfig(c); startup(c, '2026-09-08');
});
afterEach(() => { resetForTests(); rmSync(dir, { recursive: true, force: true }); });

describe('month page load', () => {
	it('defaults to the current month and honours ?month', async () => {
		const a = (await load({ url: new URL('http://localhost/') } as never)) as { view: { month: string } };
		expect(a.view.month).toMatch(/^\d{4}-\d{2}$/);
		const b = (await load({ url: new URL('http://localhost/?month=2026-07') } as never)) as { view: { month: string; label: string } };
		expect(b.view.month).toBe('2026-07'); expect(b.view.label).toBe('July 2026');
	});
});
