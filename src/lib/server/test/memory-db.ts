import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../db/schema';

/** A fresh in-memory database with every migration applied. Tests only. */
export function openMemoryDatabase(migrationsFolder = 'drizzle') {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	const db = drizzle({ client: sqlite, schema });
	migrate(db, { migrationsFolder });
	return { db, sqlite };
}
