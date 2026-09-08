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
	dir = mkdtempSync(join(tmpdir(), 'shiso-ledger-'));
	const c = cfg(dir); setConfig(c); startup(c, '2026-09-08');
});
afterEach(() => { resetForTests(); rmSync(dir, { recursive: true, force: true }); });

describe('ledger page load', () => {
	it('parses filters and pages', async () => {
		const d = (await load({ url: new URL('http://localhost/ledger?review=1&page=2&q=foo&from=2026-09-01') } as never)) as { filter: Record<string, unknown>; page: number; view: { offset: number } };
		expect(d.filter).toMatchObject({ review: true, q: 'foo', from: '2026-09-01', to: null, accountId: null });
		expect(d.page).toBe(2); expect(d.view.offset).toBe(100);
	});
});
