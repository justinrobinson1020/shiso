import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupDatabase, pruneBackups } from './backup';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiso-backup-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
describe('backupDatabase', () => {
	it('writes a dated copy that opens as a database, replacing a same-day file', () => {
		const db = new Database(join(dir, 'live.db')); db.exec('create table t (x); insert into t values (1)');
		const out = join(dir, 'bk');
		const p1 = backupDatabase(db, out, '2026-09-08'); expect(p1).toBe(join(out, 'shiso-2026-09-08.db'));
		db.exec('insert into t values (2)');
		const p2 = backupDatabase(db, out, '2026-09-08'); expect(p2).toBe(p1);
		const copy = new Database(p2, { readonly: true }); expect(copy.prepare('select count(*) as n from t').get()).toEqual({ n: 2 }); copy.close(); db.close();
	});
});
describe('pruneBackups', () => {
	it('keeps the newest N dated backups and never touches migration snapshots', () => {
		for (const d of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) writeFileSync(join(dir, `shiso-${d}.db`), '');
		writeFileSync(join(dir, 'pre-migration-2026-09-01T00-00-00-000Z-0001.db'), '');
		const deleted = pruneBackups(dir, 2);
		expect(deleted.map((p) => p.split('/').pop())).toEqual(['shiso-2026-09-01.db', 'shiso-2026-09-02.db']);
		expect(readdirSync(dir).sort()).toEqual(['pre-migration-2026-09-01T00-00-00-000Z-0001.db', 'shiso-2026-09-03.db', 'shiso-2026-09-04.db']);
		expect(existsSync(join(dir, 'shiso-2026-09-04.db'))).toBe(true);
	});
});
