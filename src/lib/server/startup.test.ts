import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from './startup';
import { getDb, getSqlite } from './db/instance';
import { periods, categories } from './db/schema';
import { asc } from 'drizzle-orm';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiso-start-')); resetForTests(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetForTests(); });

const cfg = (d: string) => ({
	dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40),
	timeZone: 'America/New_York', migrationsDir: 'drizzle',
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7,
	plaid: { clientId: null, secret: null, env: 'sandbox' as const }
});

describe('startup', () => {
	it('opens, seeds, and creates the current and next period on a fresh database', () => {
		const report = startup(cfg(dir), '2026-09-04');
		const db = getDb();
		const rows = db.select().from(periods).orderBy(asc(periods.startDate)).all();
		expect(rows.map((r) => r.startDate)).toEqual(['2026-09-01', '2026-09-16']);
		expect(db.select().from(categories).all().some((c) => c.kind === 'income')).toBe(true);
		expect(report.pendingMigrations).toBe(0);
		expect(report.snapshot).toBeNull();
	});
	it('is idempotent across restarts', () => {
		startup(cfg(dir), '2026-09-04');
		resetForTests();
		startup(cfg(dir), '2026-09-20');
		const db = getDb();
		expect(db.select().from(periods).all().length).toBe(3); // Sep a, Sep b, Oct a
	});
	it('closes a gap left by downtime across a boundary', () => {
		startup(cfg(dir), '2026-09-04');
		resetForTests();
		startup(cfg(dir), '2026-11-20'); // process was down for October
		const db = getDb();
		const starts = db.select().from(periods).orderBy(asc(periods.startDate)).all().map((r) => r.startDate);
		expect(starts).toEqual(['2026-09-01', '2026-09-16', '2026-10-01', '2026-10-16', '2026-11-01', '2026-11-16', '2026-12-01']);
	});
	it('closes the previous database handle when startup runs twice in one process', () => {
		startup(cfg(dir), '2026-09-04');
		const first = getSqlite();
		startup(cfg(dir), '2026-09-04');
		expect(first.open).toBe(false);
		expect(getSqlite().open).toBe(true);
	});
});
