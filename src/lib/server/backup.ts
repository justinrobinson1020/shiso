import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
const DATED = /^shiso-(\d{4}-\d{2}-\d{2})\.db$/;
/** §3.1: a dated `VACUUM INTO` copy; one per calendar day, the later run wins. */
export function backupDatabase(sqlite: Database.Database, dir: string, todayIso: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `shiso-${todayIso}.db`);
	// Snapshot beside the target and rename over it, so a failed VACUUM never costs the day's existing backup.
	const partial = `${path}.partial`;
	rmSync(partial, { force: true });
	try {
		sqlite.exec(`VACUUM INTO '${partial.replace(/'/g, "''")}'`);
		renameSync(partial, path);
	} catch (err) {
		rmSync(partial, { force: true });
		throw err;
	}
	return path;
}
export function pruneBackups(dir: string, keep: number): string[] {
	if (!existsSync(dir)) return [];
	const dated = readdirSync(dir).filter((f) => DATED.test(f)).sort();
	const doomed = dated.slice(0, Math.max(0, dated.length - keep));
	for (const f of doomed) rmSync(join(dir, f));
	return doomed.map((f) => join(dir, f));
}
