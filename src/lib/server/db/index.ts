import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';
import { pendingMigrations } from './migrations';

export type Db = BetterSQLite3Database<typeof schema>;
/** The handle a `db.transaction((tx) => …)` callback receives. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Service functions accept either, so they compose inside a caller's transaction. */
export type DbOrTx = Db | Tx;
export { schema };
export { pendingMigrations };

const DEFAULT_MIGRATIONS = 'drizzle';

function configure(sqlite: Database.Database) {
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('busy_timeout = 5000');
}

export function openDatabase(opts: { path: string; backupDir: string; migrationsFolder?: string }) {
	const migrationsFolder = opts.migrationsFolder ?? DEFAULT_MIGRATIONS;
	mkdirSync(dirname(opts.path), { recursive: true });
	const sqlite = new Database(opts.path);
	configure(sqlite);

	let snapshot: string | null = null;
	const pending = pendingMigrations(sqlite, migrationsFolder);
	const isFresh = sqlite.prepare("select count(*) as n from sqlite_master where type='table'").get() as { n: number };
	if (pending.length > 0 && isFresh.n > 0) {
		mkdirSync(opts.backupDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		snapshot = join(opts.backupDir, `pre-migration-${stamp}-${pending[0]}.db`);
		sqlite.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
	}

	const db = drizzle({ client: sqlite, schema });
	if (pending.length > 0) migrate(db, { migrationsFolder });
	return { db, sqlite, snapshot };
}

export function openMemoryDatabase(migrationsFolder = DEFAULT_MIGRATIONS) {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	const db = drizzle({ client: sqlite, schema });
	migrate(db, { migrationsFolder });
	return { db, sqlite };
}
