import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products, type LinkTokenCreateRequest, type LinkTokenTransactions } from 'plaid';
import type { AccountType } from '../../db/schema';
import { decimalToCents } from '$lib/money';
import { ProviderError, type BatchAccount, type BatchBalance, type BatchTerms, type BatchTransaction, type FetchInput, type SyncBatch, type SyncProvider } from '../types';

// ---- the slice of the Plaid API this provider uses (structurally satisfied by PlaidApi) ----
type PlaidBalances = { current: number | null; available: number | null; limit: number | null };
type PlaidAccount = { account_id: string; name: string; official_name: string | null; mask: string | null; type: string; subtype: string | null; balances: PlaidBalances };
type PlaidTransaction = {
	transaction_id: string; account_id: string; amount: number; date: string; authorized_date: string | null; authorized_datetime?: string | null;
	name: string; merchant_name?: string | null; pending: boolean; pending_transaction_id: string | null;
	personal_finance_category?: { primary: string; detailed: string } | null;
};
type SyncData = { added: PlaidTransaction[]; modified: PlaidTransaction[]; removed: { transaction_id: string; account_id: string }[]; next_cursor: string; has_more: boolean; accounts: PlaidAccount[] };
type Apr = { apr_type: string; apr_percentage: number };
// Plaid names these arrays `credit` / `student` / `mortgage`, and leaves `account_id` nullable on the
// first two. Every field is widened to what the SDK actually promises so PlaidApi satisfies this type.
type CreditLiability = { account_id: string | null; aprs?: Apr[] | null; minimum_payment_amount: number | null; next_payment_due_date: string | null; last_statement_balance: number | null; last_statement_issue_date: string | null };
type StudentLiability = { account_id: string | null; interest_rate_percentage: number | null; minimum_payment_amount: number | null; next_payment_due_date: string | null; last_statement_balance?: number | null; last_statement_issue_date?: string | null };
type MortgageLiability = { account_id: string; interest_rate: { percentage: number | null } | null; next_monthly_payment: number | null; next_payment_due_date: string | null };
export type LiabilitiesData = { accounts: PlaidAccount[]; liabilities: { credit: CreditLiability[] | null; student: StudentLiability[] | null; mortgage: MortgageLiability[] | null } };

export type PlaidClientLike = {
	transactionsSync(req: { access_token: string; cursor?: string | null; count?: number; options?: { include_personal_finance_category?: boolean } }): Promise<{ data: SyncData }>;
	liabilitiesGet(req: { access_token: string }): Promise<{ data: LiabilitiesData }>;
	accountsBalanceGet(req: { access_token: string }): Promise<{ data: { accounts: PlaidAccount[] } }>;
	linkTokenCreate(req: LinkTokenCreateRequest): Promise<{ data: { link_token: string } }>;
	itemPublicTokenExchange(req: { public_token: string }): Promise<{ data: { access_token: string; item_id: string } }>;
};

export const RELINK_CODES = ['ITEM_LOGIN_REQUIRED', 'INVALID_CREDENTIALS', 'ITEM_NOT_FOUND', 'ACCESS_NOT_GRANTED', 'INVALID_ACCESS_TOKEN'];
export const MUTATION_CODE = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
const SKIP_LIABILITY_CODES = ['PRODUCT_NOT_READY', 'NO_LIABILITY_ACCOUNTS', 'PRODUCTS_NOT_SUPPORTED', 'ADDITIONAL_CONSENT_REQUIRED'];

export function plaidErrorCode(err: unknown): string | null {
	const code = (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code;
	return typeof code === 'string' ? code : null;
}

function toProviderError(err: unknown): ProviderError {
	const code = plaidErrorCode(err);
	if (code) return new ProviderError(code, (err as { response: { data: { error_message?: string } } }).response.data.error_message ?? code, RELINK_CODES.includes(code));
	return new ProviderError('PLAID_REQUEST_FAILED', (err as Error).message ?? String(err));
}

export function mapPlaidAccountType(type: string, subtype: string | null): AccountType {
	if (type === 'depository') return subtype === 'checking' ? 'checking' : 'savings';
	if (type === 'credit') return 'credit';
	if (type === 'loan') return 'loan';
	if (type === 'investment' || type === 'brokerage') return 'investment';
	return 'cash';
}

const cents = (n: number | null | undefined): number | null => (n == null ? null : decimalToCents(n));
const bps = (pct: number | null | undefined): number | null => (pct == null ? null : Math.round(pct * 100));

function mapAccount(a: PlaidAccount): BatchAccount {
	return { externalId: a.account_id, name: a.name, officialName: a.official_name ?? null, mask: a.mask ?? null, type: mapPlaidAccountType(a.type, a.subtype) };
}
function mapBalance(a: PlaidAccount, asOf: string): BatchBalance {
	const owed = a.type === 'credit' || a.type === 'loan';
	const current = cents(a.balances.current) ?? 0;
	return { accountExternalId: a.account_id, asOf, current: owed ? -current : current, available: cents(a.balances.available), creditLimit: cents(a.balances.limit) };
}
function mapTransaction(t: PlaidTransaction): BatchTransaction {
	return {
		accountExternalId: t.account_id, externalId: t.transaction_id, pendingExternalId: t.pending_transaction_id ?? null,
		postedDate: t.date, transactedAt: t.authorized_datetime ?? (t.authorized_date ? `${t.authorized_date}T00:00:00Z` : null),
		amount: -decimalToCents(t.amount), payeeRaw: t.merchant_name ?? t.name, pending: t.pending,
		providerCategory: t.personal_finance_category?.detailed ?? t.personal_finance_category?.primary ?? null
	};
}
function mapTerms(l: LiabilitiesData['liabilities'], asOf: string): BatchTerms[] {
	const out: BatchTerms[] = [];
	// A liability with no account_id has no account to attach terms to; skip it rather than fail the sync.
	for (const c of l.credit ?? []) {
		if (c.account_id == null) continue;
		const aprs = c.aprs ?? [];
		out.push({
			accountExternalId: c.account_id, asOf,
			aprBps: bps(aprs.find((a) => a.apr_type === 'purchase_apr')?.apr_percentage), promoAprBps: bps(aprs.find((a) => a.apr_type === 'special')?.apr_percentage),
			minPayment: cents(c.minimum_payment_amount), nextDueDate: c.next_payment_due_date ?? null,
			lastStatementBalance: cents(c.last_statement_balance), lastStatementDate: c.last_statement_issue_date ?? null, annualFee: null
		});
	}
	for (const s of l.student ?? []) {
		if (s.account_id == null) continue;
		out.push({
			accountExternalId: s.account_id, asOf, aprBps: bps(s.interest_rate_percentage), promoAprBps: null,
			minPayment: cents(s.minimum_payment_amount), nextDueDate: s.next_payment_due_date ?? null,
			lastStatementBalance: cents(s.last_statement_balance), lastStatementDate: s.last_statement_issue_date ?? null, annualFee: null
		});
	}
	for (const m of l.mortgage ?? []) out.push({
		accountExternalId: m.account_id, asOf, aprBps: bps(m.interest_rate?.percentage), promoAprBps: null,
		minPayment: cents(m.next_monthly_payment), nextDueDate: m.next_payment_due_date ?? null,
		lastStatementBalance: null, lastStatementDate: null, annualFee: null
	});
	return out;
}

export class PlaidProvider implements SyncProvider {
	readonly kind = 'plaid' as const;
	private readonly pageSize: number;
	private readonly maxRestarts: number;
	constructor(private readonly client: PlaidClientLike, opts: { pageSize?: number; maxRestarts?: number } = {}) {
		this.pageSize = opts.pageSize ?? 500;
		this.maxRestarts = opts.maxRestarts ?? 3;
	}

	async fetch(input: FetchInput): Promise<SyncBatch> {
		if (!input.credential) throw new ProviderError('NO_CREDENTIAL', 'connection has no access token', true);
		const access_token = input.credential;
		if (input.mode === 'balances') {
			let accounts: PlaidAccount[];
			try { accounts = (await this.client.accountsBalanceGet({ access_token })).data.accounts; } catch (err) { throw toProviderError(err); }
			return { accounts: accounts.map(mapAccount), balances: accounts.map((a) => mapBalance(a, input.todayIso)), terms: [], added: [], modified: [], removed: [], nextCursor: input.cursor, sendsRemovals: true, coversFrom: null };
		}

		// Fetch every page before applying anything (§5.2); restart from the run-start cursor on mutation.
		let restarts = 0;
		let pages: SyncData[] = [];
		let cursor = input.cursor;
		for (;;) {
			try {
				const { data } = await this.client.transactionsSync({ access_token, cursor, count: this.pageSize, options: { include_personal_finance_category: true } });
				pages.push(data);
				cursor = data.next_cursor;
				if (!data.has_more) break;
			} catch (err) {
				if (plaidErrorCode(err) === MUTATION_CODE && restarts++ < this.maxRestarts) { pages = []; cursor = input.cursor; continue; }
				throw toProviderError(err);
			}
		}

		let terms: BatchTerms[] = [];
		let liabilityAccounts: PlaidAccount[] = [];
		try {
			const { accounts: la, liabilities } = (await this.client.liabilitiesGet({ access_token })).data;
			liabilityAccounts = la;
			terms = mapTerms(liabilities, input.todayIso);
		} catch (err) { if (!SKIP_LIABILITY_CODES.includes(plaidErrorCode(err) ?? '')) throw toProviderError(err); }

		const accountsById = new Map<string, PlaidAccount>();
		for (const p of pages) for (const a of p.accounts ?? []) accountsById.set(a.account_id, a);
		// /liabilities/get also returns accounts for loan-type accounts (student loans, mortgages) that
		// never appear in a /transactions/sync page; merge them in without letting them override a page account.
		for (const a of liabilityAccounts) if (!accountsById.has(a.account_id)) accountsById.set(a.account_id, a);
		const accounts = [...accountsById.values()];
		return {
			accounts: accounts.map(mapAccount),
			balances: accounts.map((a) => mapBalance(a, input.todayIso)),
			terms,
			added: pages.flatMap((p) => p.added.map(mapTransaction)),
			modified: pages.flatMap((p) => p.modified.map(mapTransaction)),
			removed: pages.flatMap((p) => p.removed.map((r) => ({ accountExternalId: r.account_id, externalId: r.transaction_id }))),
			nextCursor: cursor,
			sendsRemovals: true,
			coversFrom: null
		};
	}
}

export function createPlaidClient(cfg: { clientId: string; secret: string; env: 'sandbox' | 'production' }): PlaidApi {
	return new PlaidApi(new Configuration({
		basePath: PlaidEnvironments[cfg.env],
		baseOptions: { headers: { 'PLAID-CLIENT-ID': cfg.clientId, 'PLAID-SECRET': cfg.secret } }
	}));
}

export async function createLinkToken(client: PlaidClientLike, opts: { clientName: string; userId: string; accessToken?: string | null }): Promise<string> {
	const req: LinkTokenCreateRequest = { client_name: opts.clientName, user: { client_user_id: opts.userId }, country_codes: [CountryCode.Us], language: 'en' };
	if (opts.accessToken) req.access_token = opts.accessToken;
	else {
		// Liabilities as a required product makes Link refuse a login without a credit or loan account
		// ("No liability accounts"). required_if_supported_products still requires it whenever the
		// *institution* supports liabilities, so a savings-only login at a card issuer (Amex) fails the
		// same way. optional_products is best-effort per Item: Link never refuses for lack of it, and the
		// sync already tolerates NO_LIABILITY_ACCOUNTS on Items without it.
		req.products = [Products.Transactions];
		req.optional_products = [Products.Liabilities];
		// days_requested only applies when Transactions has not been initialised on the Item, so it is
		// harmless to always send for new Items and pointless on relink.
		const transactions: LinkTokenTransactions = { days_requested: 730 };
		req.transactions = transactions;
	}
	try { return (await client.linkTokenCreate(req)).data.link_token; } catch (err) { throw toProviderError(err); }
}

export async function exchangePublicToken(client: PlaidClientLike, publicToken: string): Promise<{ accessToken: string; itemId: string }> {
	try {
		const { data } = await client.itemPublicTokenExchange({ public_token: publicToken });
		return { accessToken: data.access_token, itemId: data.item_id };
	} catch (err) { throw toProviderError(err); }
}
