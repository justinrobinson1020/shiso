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

describe('spending page load', () => {
	it('defaults to the current period and parses the range and filters', async () => {
		const d = (await load({ url: new URL('http://localhost/spending?kind=month&anchor=2026-07-10&compare=1&all=1') } as never)) as { view: { range: { kind: string; start: string }; filter: { compare: boolean; includeExcluded: boolean } } };
		expect(d.view.range).toMatchObject({ kind: 'month', start: '2026-07-01' }); expect(d.view.filter).toMatchObject({ compare: true, includeExcluded: true });
		const e = (await load({ url: new URL('http://localhost/spending') } as never)) as { view: { range: { kind: string } } };
		expect(e.view.range.kind).toBe('period');
	});
});
