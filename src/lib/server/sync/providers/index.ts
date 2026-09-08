import type { Config } from '../../config';
import { getConfig } from '../../config';
import type { Provider } from '../../db/schema';
import type { SyncProvider } from '../types';
import type { SyncDeps } from '../runner';
import { ManualProvider } from './manual';
import { SimpleFinProvider } from './simplefin';
import { PlaidProvider, createPlaidClient, type PlaidClientLike } from './plaid';

/** The Plaid API client, or null when the credentials are not configured. */
export function plaidClient(config: Config): PlaidClientLike | null {
	if (!config.plaid.clientId || !config.plaid.secret) return null;
	// PlaidApi widens a few optional fields (e.g. merchant_name may be undefined) that PlaidClientLike narrows; the provider treats them the same.
	return createPlaidClient({ clientId: config.plaid.clientId, secret: config.plaid.secret, env: config.plaid.env }) as unknown as PlaidClientLike;
}

/** `manual` and `simplefin` always; `plaid` only when both credentials are set. */
export function buildProviders(config: Config): Partial<Record<Provider, SyncProvider>> {
	const providers: Partial<Record<Provider, SyncProvider>> = { manual: new ManualProvider(), simplefin: new SimpleFinProvider() };
	const client = plaidClient(config);
	if (client) providers.plaid = new PlaidProvider(client);
	return providers;
}

export function cronExpressions(config: Pick<Config, 'syncHour' | 'balanceHour'>): { full: string; balances: string } {
	return { full: `0 ${config.syncHour} * * *`, balances: `0 ${config.balanceHour} * * *` };
}

export function buildSyncDeps(config: Config): SyncDeps {
	return { providers: buildProviders(config), appKey: config.appKey, cadence: config.cadence, timeZone: config.timeZone };
}

let override: SyncDeps | null = null;
let cached: SyncDeps | null = null;
export function setSyncDepsForTests(deps: SyncDeps | null): void { override = deps; cached = null; }
/** The process-wide sync dependencies: the test override if set, otherwise built once from `getConfig()`. */
export function syncDeps(): SyncDeps {
	if (override) return override;
	if (!cached) cached = buildSyncDeps(getConfig());
	return cached;
}
