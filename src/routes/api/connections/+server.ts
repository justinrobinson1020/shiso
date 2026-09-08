import { handle, readJson, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { createConnection, upsertAccount } from '$lib/server/sync/connections';
import { ACCOUNT_TYPES, type AccountType } from '$lib/server/db/schema';

export const POST = handle(async ({ request }) => {
	const b = await readJson<{ institutionName?: string; accounts?: { name?: string; type?: string }[] }>(request);
	if (!b.institutionName?.trim()) throw new ValidationError('institutionName is required');
	if (!Array.isArray(b.accounts) || b.accounts.length === 0) throw new ValidationError('at least one account is required');
	for (const a of b.accounts) {
		if (!a.name?.trim()) throw new ValidationError('account name is required');
		if (!(ACCOUNT_TYPES as readonly string[]).includes(a.type ?? '')) throw new ValidationError(`account type is invalid: ${a.type}`);
	}
	const db = getDb();
	return db.transaction((tx) => {
		const connectionId = createConnection(tx, { provider: 'manual', institutionName: b.institutionName!.trim(), appKey: getConfig().appKey });
		const accountIds = b.accounts!.map((a, i) => upsertAccount(tx, connectionId, { externalId: `manual:${i + 1}`, name: a.name!.trim(), type: a.type as AccountType }).id);
		return { connectionId, accountIds };
	});
});
