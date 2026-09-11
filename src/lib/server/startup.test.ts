import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup, resetForTests } from './startup';
import { currentPeriodId, ensurePeriods } from './budget/periods';
import { getSetting, BUDGET_START_KEY } from './settings';
import { getDb, getSqlite } from './db/instance';
import { periods, categories } from './db/schema';
import { asc, eq } from 'drizzle-orm';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiso-start-')); resetForTests(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetForTests(); });

const cfg = (d: string) => ({
	dbPath: join(d, 'shiso.db'), backupDir: join(d, 'backups'), appKey: 'k'.repeat(40),
	timeZone: 'America/New_York', migrationsDir: 'drizzle',
	cadence: 'semi_monthly' as const, syncHour: 3, balanceHour: 7, backupHour: 4, backupKeep: 30,
	plaid: { clientId: null, secret: null, env: 'sandbox' as const },
	schedulerEnabled: false, plaidClientName: 'shiso'
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
	it('extends periods on demand when the process outlives the back-fill', () => {
		startup(cfg(dir), '2026-09-04');
		const db = getDb();
		const id = currentPeriodId(db, 'semi_monthly', '2026-11-20');
		const row = db.select().from(periods).where(eq(periods.id, id)).get();
		expect(row?.startDate).toBe('2026-11-16');
		const starts = db.select().from(periods).orderBy(asc(periods.startDate)).all().map((r) => r.startDate);
		expect(starts).toContain('2026-12-01');
	});
	it('closes the previous database handle when startup runs twice in one process', () => {
		startup(cfg(dir), '2026-09-04');
		const first = getSqlite();
		startup(cfg(dir), '2026-09-04');
		expect(first.open).toBe(false);
		expect(getSqlite().open).toBe(true);
	});
	it('pins budget_start to the earliest period on first run and never moves it', () => {
		startup(cfg(dir), '2026-09-04');
		expect(getSetting(getDb(), BUDGET_START_KEY, null)).toBe('2026-09-01');
		ensurePeriods(getDb(), 'semi_monthly', '2024-09-01', '2024-09-30');   // history arrives later
		resetForTests();
		startup(cfg(dir), '2026-09-20');
		expect(getDb().select().from(periods).orderBy(asc(periods.startDate)).get()?.startDate).toBe('2024-09-01');
		expect(getSetting(getDb(), BUDGET_START_KEY, null)).toBe('2026-09-01');
	});
});
