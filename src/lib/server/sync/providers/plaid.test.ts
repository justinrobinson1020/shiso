import { describe, it, expect } from 'vitest';
import { PlaidProvider, mapPlaidAccountType, plaidErrorCode, createLinkToken, exchangePublicToken, type LiabilitiesData, type PlaidClientLike } from './plaid';
import { ProviderError } from '../types';

type Page = { added?: unknown[]; modified?: unknown[]; removed?: unknown[]; next_cursor: string; has_more: boolean; accounts?: unknown[] };
const account = (id: string, type: string, subtype: string, current: number, limit: number | null = null) =>
	({ account_id: id, name: `${id} name`, official_name: null, mask: '1234', type, subtype, balances: { current, available: null, limit, iso_currency_code: 'USD' } });
const txn = (id: string, acct: string, amount: number, date: string, extra: Record<string, unknown> = {}) =>
	({ transaction_id: id, account_id: acct, amount, date, authorized_date: null, authorized_datetime: null, name: `TX ${id}`, merchant_name: null, pending: false, pending_transaction_id: null, personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'x' }, ...extra });
const plaidErr = (code: string) => Object.assign(new Error(code), { response: { data: { error_code: code, error_type: 'X', error_message: code } } });

function fakeClient(pages: (Page | Error)[], liabilities: LiabilitiesData['liabilities'] = { credit: [], student: [], mortgage: [] }): PlaidClientLike & { syncCalls: unknown[] } {
	const syncCalls: unknown[] = [];
	return {
		syncCalls,
		async transactionsSync(req) {
			syncCalls.push(req);
			const p = pages.shift();
			if (!p) throw new Error('no more pages');
			if (p instanceof Error) throw p;
			return { data: { added: [], modified: [], removed: [], accounts: [], ...p } as never };
		},
		async liabilitiesGet() { return { data: { liabilities } }; },
		async accountsBalanceGet() { return { data: { accounts: [account('a1', 'depository', 'checking', 123.45)] } as never }; },
		async linkTokenCreate(req) { syncCalls.push({ link: req }); return { data: { link_token: 'link-1' } as never }; },
		async itemPublicTokenExchange(req) { syncCalls.push({ exchange: req }); return { data: { access_token: 'access-9', item_id: 'item-9' } as never }; }
	};
}

describe('PlaidProvider.fetch', () => {
	it('pages through transactionsSync, maps signs and types, and returns the last cursor', async () => {
		const client = fakeClient([
			{ accounts: [account('a1', 'depository', 'checking', 1000.5), account('c1', 'credit', 'credit card', 250.25, 5000)],
			  added: [txn('t1', 'a1', 12.34, '2026-09-02'), txn('t2', 'c1', -20, '2026-09-03', { merchant_name: 'Refund Co', pending: true })],
			  next_cursor: 'c1', has_more: true },
			{ modified: [txn('t1', 'a1', 12.5, '2026-09-02')], removed: [{ transaction_id: 't0', account_id: 'a1' }], next_cursor: 'c2', has_more: false }
		]);
		const b = await new PlaidProvider(client).fetch({ credential: 'access', cursor: null, mode: 'full', todayIso: '2026-09-08' });
		expect(b.accounts).toEqual([
			{ externalId: 'a1', name: 'a1 name', officialName: null, mask: '1234', type: 'checking' },
			{ externalId: 'c1', name: 'c1 name', officialName: null, mask: '1234', type: 'credit' }
		]);
		expect(b.balances).toEqual([
			{ accountExternalId: 'a1', asOf: '2026-09-08', current: 100050, available: null, creditLimit: null },
			{ accountExternalId: 'c1', asOf: '2026-09-08', current: -25025, available: null, creditLimit: 500000 }
		]);
		expect(b.added[0]).toMatchObject({ accountExternalId: 'a1', externalId: 't1', amount: -1234, postedDate: '2026-09-02', payeeRaw: 'TX t1', providerCategory: 'GENERAL_MERCHANDISE', pending: false });
		expect(b.added[1]).toMatchObject({ externalId: 't2', amount: 2000, payeeRaw: 'Refund Co', pending: true });
		expect(b.modified[0]).toMatchObject({ externalId: 't1', amount: -1250 });
		expect(b.removed).toEqual([{ accountExternalId: 'a1', externalId: 't0' }]);
		expect(b.nextCursor).toBe('c2');
		expect(b.sendsRemovals).toBe(true);
		expect((client.syncCalls[1] as { cursor: string }).cursor).toBe('c1');
	});
	it('restarts from the run-start cursor on a mutation error and discards the partial buffer', async () => {
		const client = fakeClient([
			{ added: [txn('x', 'a1', 1, '2026-09-01')], accounts: [account('a1', 'depository', 'checking', 1)], next_cursor: 'p1', has_more: true },
			plaidErr('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'),
			{ added: [txn('y', 'a1', 2, '2026-09-01')], accounts: [account('a1', 'depository', 'checking', 1)], next_cursor: 'q1', has_more: false }
		]);
		const b = await new PlaidProvider(client).fetch({ credential: 'access', cursor: 'start', mode: 'full', todayIso: '2026-09-08' });
		expect(b.added.map((t) => t.externalId)).toEqual(['y']);
		expect((client.syncCalls[2] as { cursor: string }).cursor).toBe('start');
	});
	it('maps a login error to a relink ProviderError', async () => {
		const client = fakeClient([plaidErr('ITEM_LOGIN_REQUIRED')]);
		await expect(new PlaidProvider(client).fetch({ credential: 'access', cursor: null, mode: 'full', todayIso: '2026-09-08' }))
			.rejects.toMatchObject({ code: 'ITEM_LOGIN_REQUIRED', needsRelink: true });
		await expect(new PlaidProvider(fakeClient([plaidErr('RATE_LIMIT_EXCEEDED')])).fetch({ credential: 'access', cursor: null, mode: 'full', todayIso: '2026-09-08' }))
			.rejects.toBeInstanceOf(ProviderError);
	});
	it('maps liabilities into terms', async () => {
		const client = fakeClient(
			[{ accounts: [account('c1', 'credit', 'credit card', 100)], next_cursor: 'c', has_more: false }],
			{ credit: [{ account_id: 'c1', aprs: [{ apr_type: 'purchase_apr', apr_percentage: 27.49 }, { apr_type: 'special', apr_percentage: 0 }],
				minimum_payment_amount: 35.6, next_payment_due_date: '2026-09-26', last_statement_balance: 11770.95, last_statement_issue_date: '2026-09-01' }],
			  student: [{ account_id: 'l1', interest_rate_percentage: 15.25, minimum_payment_amount: 878.29, next_payment_due_date: '2026-09-21', last_statement_balance: 12989.71, last_statement_issue_date: '2026-09-03' }],
			  mortgage: [] }
		);
		const b = await new PlaidProvider(client).fetch({ credential: 'access', cursor: null, mode: 'full', todayIso: '2026-09-08' });
		expect(b.terms).toEqual([
			{ accountExternalId: 'c1', asOf: '2026-09-08', aprBps: 2749, promoAprBps: 0, minPayment: 3560, nextDueDate: '2026-09-26', lastStatementBalance: 1177095, lastStatementDate: '2026-09-01', annualFee: null },
			{ accountExternalId: 'l1', asOf: '2026-09-08', aprBps: 1525, promoAprBps: null, minPayment: 87829, nextDueDate: '2026-09-21', lastStatementBalance: 1298971, lastStatementDate: '2026-09-03', annualFee: null }
		]);
	});
	it('skips a liability with no account_id and a credit card with no aprs array', async () => {
		const client = fakeClient(
			[{ accounts: [account('c1', 'credit', 'credit card', 100)], next_cursor: 'c', has_more: false }],
			{ credit: [
				{ account_id: null, aprs: [{ apr_type: 'purchase_apr', apr_percentage: 21 }], minimum_payment_amount: 25, next_payment_due_date: null, last_statement_balance: null, last_statement_issue_date: null },
				{ account_id: 'c2', minimum_payment_amount: 25, next_payment_due_date: null, last_statement_balance: null, last_statement_issue_date: null }
			], student: [{ account_id: null, interest_rate_percentage: 5, minimum_payment_amount: 10, next_payment_due_date: null, last_statement_balance: null, last_statement_issue_date: null }], mortgage: [] }
		);
		const b = await new PlaidProvider(client).fetch({ credential: 'access', cursor: null, mode: 'full', todayIso: '2026-09-08' });
		// the two null-account rows have nothing to attach terms to; the aprs-less card still maps, with null rates
		expect(b.terms).toEqual([
			{ accountExternalId: 'c2', asOf: '2026-09-08', aprBps: null, promoAprBps: null, minPayment: 2500, nextDueDate: null, lastStatementBalance: null, lastStatementDate: null, annualFee: null }
		]);
	});
	it('balances mode only fetches balances and keeps the cursor', async () => {
		const client = fakeClient([]);
		const b = await new PlaidProvider(client).fetch({ credential: 'access', cursor: 'keep', mode: 'balances', todayIso: '2026-09-08' });
		expect(b.balances).toEqual([{ accountExternalId: 'a1', asOf: '2026-09-08', current: 12345, available: null, creditLimit: null }]);
		expect(b.added).toEqual([]);
		expect(b.nextCursor).toBe('keep');
	});
});

describe('helpers', () => {
	it('maps account types', () => {
		expect(mapPlaidAccountType('depository', 'checking')).toBe('checking');
		expect(mapPlaidAccountType('depository', 'money market')).toBe('savings');
		expect(mapPlaidAccountType('credit', 'credit card')).toBe('credit');
		expect(mapPlaidAccountType('loan', 'student')).toBe('loan');
		expect(mapPlaidAccountType('investment', 'brokerage')).toBe('investment');
		expect(mapPlaidAccountType('other', null)).toBe('cash');
	});
	it('reads error codes and drives Link', async () => {
		expect(plaidErrorCode(plaidErr('X'))).toBe('X');
		expect(plaidErrorCode(new Error('plain'))).toBeNull();
		const client = fakeClient([]);
		expect(await createLinkToken(client, { clientName: 'shiso', userId: 'u1' })).toBe('link-1');
		expect(await createLinkToken(client, { clientName: 'shiso', userId: 'u1', accessToken: 'access-1' })).toBe('link-1');
		expect(await exchangePublicToken(client, 'public-1')).toEqual({ accessToken: 'access-9', itemId: 'item-9' });
		expect(client.syncCalls[0]).toMatchObject({ link: { products: ['transactions', 'liabilities'], user: { client_user_id: 'u1' } } });
		expect(client.syncCalls[1]).toMatchObject({ link: { access_token: 'access-1' } });
		expect((client.syncCalls[1] as { link: Record<string, unknown> }).link.products).toBeUndefined();
	});
});
