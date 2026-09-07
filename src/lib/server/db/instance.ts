import type Database from 'better-sqlite3';
import type { Db } from './index';

let current: { db: Db; sqlite: Database.Database } | null = null;

export function setDb(handle: { db: Db; sqlite: Database.Database }): void {
	if (current && current.sqlite !== handle.sqlite && current.sqlite.open) current.sqlite.close();
	current = handle;
}

export function getDb(): Db {
	if (!current) throw new Error('database not initialised; startup() has not run');
	return current.db;
}

export function getSqlite(): Database.Database {
	if (!current) throw new Error('database not initialised; startup() has not run');
	return current.sqlite;
}

export function closeDb(): void {
	current?.sqlite.close();
	current = null;
}
