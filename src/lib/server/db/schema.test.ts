import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

const EXPECTED_TABLES = [
	'connections', 'accounts', 'account_balances', 'account_terms',
	'transactions', 'transaction_splits', 'bill_occurrence_transactions', 'payee_rules',
	'category_groups', 'categories', 'periods', 'budget_assignments',
	'bills', 'bill_occurrences', 'income_sources', 'income_occurrences',
	'sync_runs', 'settings',
	'planned_extras', 'promo_balances'
];

describe('schema', () => {
	it('migrates a fresh database to every table', () => {
		const sqlite = new Database(':memory:');
		const db = drizzle({ client: sqlite, schema });
		migrate(db, { migrationsFolder: 'drizzle' });
		const rows = sqlite
			.prepare("select name from sqlite_master where type='table' and name not like '\\_\\_%' escape '\\' and name not like 'sqlite_%'")
			.all() as { name: string }[];
		const names = rows.map((r) => r.name).sort();
		expect(names).toEqual([...EXPECTED_TABLES].sort());
	});

	it('enforces unique external id per account', () => {
		const sqlite = new Database(':memory:');
		const db = drizzle({ client: sqlite, schema });
		migrate(db, { migrationsFolder: 'drizzle' });
		sqlite.exec(`
			insert into connections (provider, institution_name, status) values ('manual','Test','active');
			insert into accounts (connection_id, external_id, name, type, on_budget, is_debt) values (1,'x','Chk','checking',1,0);
			insert into periods (start_date, end_date, label) values ('2026-01-01','2026-01-15','Jan 1-15, 2026');
			insert into transactions (account_id, external_id, posted_date, amount, payee_raw, payee, pending, period_id, source)
				values (1,'t1','2026-01-02',-100,'A','A',0,1,'sync');
		`);
		expect(() =>
			sqlite.exec(`insert into transactions (account_id, external_id, posted_date, amount, payee_raw, payee, pending, period_id, source)
				values (1,'t1','2026-01-03',-200,'B','B',0,1,'sync');`)
		).toThrow(/UNIQUE/);
	});
});
