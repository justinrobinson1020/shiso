import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
const DATED = /^shiso-(\d{4}-\d{2}-\d{2})\.db$/;
/** §3.1: a dated `VACUUM INTO` copy; one per calendar day, the later run wins. */
export function backupDatabase(sqlite: Database.Database, dir: string, todayIso: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `shiso-${todayIso}.db`);
	if (existsSync(path)) rmSync(path);
	sqlite.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
	return path;
}
export function pruneBackups(dir: string, keep: number): string[] {
	if (!existsSync(dir)) return [];
	const dated = readdirSync(dir).filter((f) => DATED.test(f)).sort();
	const doomed = dated.slice(0, Math.max(0, dated.length - keep));
	for (const f of doomed) rmSync(join(dir, f));
	return doomed.map((f) => join(dir, f));
}
