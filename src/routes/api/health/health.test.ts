import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET } from './+server';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';

let dir: string;
const cfg = (d: string) => ({
	dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle',
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, backupHour: 4, backupKeep: 30, plaid: { clientId: null, secret: null, env: 'sandbox' as const },
	schedulerEnabled: false, plaidClientName: 'shiso'
});
const get = () => (GET as unknown as () => Response | Promise<Response>)();

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiso-health-')); resetForTests(); });
afterEach(() => { resetForTests(); rmSync(dir, { recursive: true, force: true }); });

describe('GET /api/health', () => {
	it('reports degraded instead of throwing when the database is not initialised', async () => {
		const res = await get();
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.ok).toBe(false);
		expect(body.db).toBe('error');
		expect(typeof body.error).toBe('string');
	});
	it('reports ok with no last sync after startup', async () => {
		const c = cfg(dir); setConfig(c); startup(c, '2026-09-08');
		const res = await get();
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.currentPeriod).toBeTruthy();
		expect(body.lastSync).toEqual([]);
	});
});
