import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Cadence } from './budget/periods';

export type Config = {
	dbPath: string;
	backupDir: string;
	appKey: string;
	timeZone: string;
	migrationsDir: string;
	cadence: Cadence;
	syncHour: number;
	balanceHour: number;
	plaid: { clientId: string | null; secret: string | null; env: 'sandbox' | 'production' };
};

function required(env: Record<string, string | undefined>, key: string): string {
	const v = env[key];
	if (!v) throw new Error(`missing required environment variable ${key}`);
	return v;
}

function hour(env: Record<string, string | undefined>, key: string, fallback: number): number {
	const raw = env[key];
	if (raw === undefined || raw === '') return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0 || n > 23) throw new Error(`${key} must be an integer hour 0-23, got ${JSON.stringify(raw)}`);
	return n;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
	const dbPath = required(env, 'SHISO_DB_PATH');
	const backupDir = required(env, 'SHISO_BACKUP_DIR');
	const appKey = required(env, 'SHISO_APP_KEY');
	if (appKey.length < 32) throw new Error('SHISO_APP_KEY must be at least 32 characters');
	const cadence = (env.SHISO_CADENCE ?? 'semi_monthly') as Cadence;
	if (cadence !== 'semi_monthly' && cadence !== 'monthly') throw new Error(`SHISO_CADENCE must be semi_monthly or monthly`);
	const plaidEnv = (env.PLAID_ENV ?? 'sandbox') as 'sandbox' | 'production';
	const timeZone = env.SHISO_TZ ?? 'America/New_York';
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone });
	} catch {
		throw new Error(`SHISO_TZ is not a valid IANA time zone: ${timeZone}`);
	}
	// src/lib/server/config.ts → ../../../drizzle in dev. Production sets SHISO_MIGRATIONS_DIR.
	const migrationsDir = env.SHISO_MIGRATIONS_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');
	return {
		dbPath, backupDir, appKey, cadence, timeZone, migrationsDir,
		syncHour: hour(env, 'SHISO_SYNC_HOUR', 3),
		balanceHour: hour(env, 'SHISO_BALANCE_HOUR', 7),
		plaid: { clientId: env.PLAID_CLIENT_ID ?? null, secret: env.PLAID_SECRET ?? null, env: plaidEnv }
	};
}

let current: Config | null = null;
export function setConfig(c: Config): void { current = c; }
export function getConfig(): Config {
	if (!current) throw new Error('config not initialised; hooks.server.ts init has not run');
	return current;
}
