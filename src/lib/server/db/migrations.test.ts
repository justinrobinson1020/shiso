import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
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

	it('cleans up and throws if the snapshot fails', () => {
		const path = join(dir, 'shiso.db');
		const backupDir = join(dir, 'backups');
		// Existing database with no migrations applied: simulates an upgrade.
		const pre = new Database(path);
		pre.exec('create table legacy (x integer)');
		pre.close();
		// Occupy backupDir's path with a regular file so the snapshot step fails.
		writeFileSync(backupDir, '');
		expect(() => openDatabase({ path, backupDir })).toThrow(/snapshot failed/);
		expect(readdirSync(dir).some((f) => f.startsWith('pre-migration-'))).toBe(false);
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
