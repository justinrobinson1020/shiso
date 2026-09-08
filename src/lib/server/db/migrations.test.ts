import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, pendingMigrations } from './index';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiso-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('openDatabase', () => {
	it('creates the file, applies migrations, and does not snapshot an empty database', () => {
		const path = join(dir, 'shiso.db');
		const backupDir = join(dir, 'backups');
		const { sqlite, snapshot } = openDatabase({ path, backupDir });
		expect(existsSync(path)).toBe(true);
		expect(snapshot).toBeNull();
		expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
		expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(pendingMigrations(sqlite, 'drizzle')).toEqual([]);
		sqlite.close();
	});

	it('snapshots before applying migrations to an existing database', () => {
		const path = join(dir, 'shiso.db');
		const backupDir = join(dir, 'backups');
		// Existing database with no migrations applied: simulates an upgrade.
		const pre = new Database(path);
		pre.exec('create table legacy (x integer)');
		pre.close();
		const { sqlite, snapshot } = openDatabase({ path, backupDir });
		expect(snapshot).not.toBeNull();
		expect(readdirSync(backupDir).some((f) => f.startsWith('pre-migration-'))).toBe(true);
		const copy = new Database(snapshot!, { readonly: true });
		const tables = copy.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
		expect(tables.map((t) => t.name)).toContain('legacy');
		expect(tables.map((t) => t.name)).not.toContain('accounts');
		copy.close();
		sqlite.close();
	});

	it('cleans up a partial snapshot and does not migrate if VACUUM INTO fails', () => {
		const path = join(dir, 'shiso.db');
		const backupDir = join(dir, 'backups');
		// Existing database with no migrations applied: simulates an upgrade.
		const pre = new Database(path);
		pre.exec('create table legacy (x integer)');
		pre.close();
		mkdirSync(backupDir, { recursive: true });
		const now = () => new Date('2026-09-05T12:00:00.000Z');
		const snapshotPath = join(backupDir, 'pre-migration-2026-09-05T12-00-00-000Z-0000_init.db');
		// VACUUM INTO refuses to write over an existing file; stand in for a partial write.
		writeFileSync(snapshotPath, 'partial');
		expect(() => openDatabase({ path, backupDir, now })).toThrow(/snapshot failed/);
		expect(readdirSync(backupDir).filter((f) => f.startsWith('pre-migration-'))).toEqual([]);
		const raw = new Database(path, { readonly: true });
		const tables = raw.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
		expect(tables.map((t) => t.name)).not.toContain('accounts');
		raw.close();
	});

	it('throws if the backup directory cannot be created', () => {
		const path = join(dir, 'shiso.db');
		const backupDir = join(dir, 'backups');
		// Existing database with no migrations applied: simulates an upgrade.
		const pre = new Database(path);
		pre.exec('create table legacy (x integer)');
		pre.close();
		// Occupy backupDir's path with a regular file so mkdirSync fails.
		writeFileSync(backupDir, '');
		expect(() => openDatabase({ path, backupDir })).toThrow(/snapshot failed/);
	});

	it('closes the sqlite handle when the snapshot fails, leaking nothing', () => {
		const path = join(dir, 'shiso.db');
		const backupDir = join(dir, 'backups');
		// Existing database with no migrations applied: simulates an upgrade.
		const pre = new Database(path);
		pre.exec('create table legacy (x integer)');
		pre.close();
		// Occupy backupDir's path with a regular file so VACUUM INTO fails.
		writeFileSync(backupDir, '');
		expect(() => openDatabase({ path, backupDir })).toThrow(/snapshot failed/);
		// No leaked handle: reopening the same path in exclusive mode must succeed.
		const raw = new Database(path);
		raw.pragma('locking_mode = EXCLUSIVE');
		raw.exec('begin exclusive');
		raw.exec('commit');
		raw.close();
	});

	it('reports pending migrations by journal tag', () => {
		const path = join(dir, 'shiso.db');
		const raw = new Database(path);
		const pending = pendingMigrations(raw, 'drizzle');
		expect(pending.length).toBeGreaterThan(0);
		expect(pending[0]).toMatch(/^0000_/);
		raw.close();
	});
});
