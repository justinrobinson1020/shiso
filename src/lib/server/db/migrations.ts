import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

type Journal = { entries: { idx: number; tag: string; when: number }[] };

/** Migration tags present in the journal but not recorded in __drizzle_migrations. */
export function pendingMigrations(sqlite: Database.Database, migrationsFolder: string): string[] {
	const journalPath = join(migrationsFolder, 'meta', '_journal.json');
	if (!existsSync(journalPath)) throw new Error(`no migration journal at ${journalPath}`);
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
	const hasTable = sqlite
		.prepare("select 1 from sqlite_master where type='table' and name='__drizzle_migrations'")
		.get();
	if (!hasTable) return journal.entries.map((e) => e.tag);
	// Drizzle records created_at = the journal entry's `when` for each applied migration.
	const applied = new Set(
		(sqlite.prepare('select created_at from __drizzle_migrations').all() as { created_at: number }[])
			.map((r) => r.created_at)
	);
	return journal.entries.filter((e) => !applied.has(e.when)).map((e) => e.tag);
}
