import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { appendBalance, appendTermsIfChanged } from '../sync/connections';
import { createTransaction } from '../ledger/transactions';
import { syncRuns } from '../db/schema';
import { accountsView } from './accounts';

describe('accountsView', () => {
	it('joins balances, drift, terms, and the last run per connection', () => {
		const f = fixture();
		appendBalance(f.db, f.card, { asOf: '2026-09-08', current: -8000, creditLimit: 500000, source: 'manual' });
		appendTermsIfChanged(f.db, f.card, { asOf: '2026-09-08', aprBps: 2749, minPayment: 3500, nextDueDate: '2026-09-25', source: 'manual' });
		createTransaction(f.db, { accountId: f.card, externalId: 'x', postedDate: '2026-09-02', amount: -5000, payeeRaw: 'X', source: 'sync' });
		f.db.insert(syncRuns).values({ connectionId: f.conn, trigger: 'manual', startedAt: '2026-09-08T01:00:00.000Z', finishedAt: '2026-09-08T01:00:02.000Z', status: 'error', error: 'boom' }).run();
		f.db.insert(syncRuns).values({ connectionId: f.conn, trigger: 'cron', startedAt: '2026-09-08T03:00:00.000Z', finishedAt: '2026-09-08T03:00:05.000Z', status: 'ok', added: 4 }).run();
		const v = accountsView(f.db, { plaidConfigured: false });
		expect(v.plaidConfigured).toBe(false);
		const c = v.connections[0]; expect(c.institutionName).toBe('Test Bank'); expect(c.lastRun).toMatchObject({ status: 'ok', added: 4 });
		const card = c.accounts.find((a) => a.id === f.card)!;
		expect(card.balance).toMatchObject({ current: -8000, creditLimit: 500000, source: 'manual' });
		expect(card.drift).toMatchObject({ providerBalance: -8000, ledgerBalance: -5000, drift: -3000, convention: 'include_pending' });
		expect(card.terms).toMatchObject({ aprBps: 2749, minPayment: 3500, nextDueDate: '2026-09-25', source: 'manual' });
		expect(c.accounts.find((a) => a.id === f.checking)!.balance).toBeNull();
		expect(v.types).toContain('credit');
	});
});
