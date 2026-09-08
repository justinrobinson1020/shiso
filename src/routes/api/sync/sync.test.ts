import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from '$lib/server/startup';
import { setConfig } from '$lib/server/config';
import { setSyncDepsForTests } from '$lib/server/sync/providers';
import { createConnection } from '$lib/server/sync/connections';
import { getDb } from '$lib/server/db/instance';
import { emptyBatch, type SyncProvider } from '$lib/server/sync/types';
import { POST as syncAll } from './+server';
import { POST as syncOne } from './[connectionId]/+server';
import { POST as linkToken } from '../plaid/link-token/+server';

let dir: string;
const cfg = (d: string) => ({
	dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40), timeZone: 'America/New_York', migrationsDir: 'drizzle',
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, plaid: { clientId: null, secret: null, env: 'sandbox' as const },
	schedulerEnabled: false, plaidClientName: 'shiso'
});
const fake: SyncProvider = { kind: 'plaid', fetch: async (i) => ({ ...emptyBatch('c'), accounts: [{ externalId: 'a', name: 'A', type: 'checking' }], balances: [{ accountExternalId: 'a', asOf: i.todayIso, current: 100 }], sendsRemovals: true }) };
const req = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'shiso-routes-'));
	const c = cfg(dir); setConfig(c); startup(c, '2026-09-08');
	setSyncDepsForTests({ providers: { plaid: fake }, appKey: c.appKey, cadence: 'semi_monthly', timeZone: 'UTC', today: () => '2026-09-08' });
});
afterEach(() => { setSyncDepsForTests(null); resetForTests(); rmSync(dir, { recursive: true, force: true }); });

describe('sync routes', () => {
	it('runs every active connection and one by id', async () => {
		const id = createConnection(getDb(), { provider: 'plaid', institutionName: 'T', credential: 'x', appKey: 'k'.repeat(40) });
		const all = await (await syncAll({ request: req({}) } as never)).json();
		expect(all.runs.map((r: { status: string }) => r.status)).toEqual(['ok']);
		const one = await (await syncOne({ request: req({ mode: 'balances' }), params: { connectionId: String(id) } } as never)).json();
		expect(one.status).toBe('ok');
		const missing = await syncOne({ request: req({}), params: { connectionId: '999' } } as never);
		expect(missing.status).toBe(404);
	});
	it('rejects link token requests when plaid is not configured', async () => {
		setSyncDepsForTests({ providers: {}, appKey: 'k'.repeat(40), cadence: 'semi_monthly', timeZone: 'UTC' });
		const res = await linkToken({ request: req({}) } as never);
		expect(res.status).toBe(400);
	});
});
