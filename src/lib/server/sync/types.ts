import type { AccountType, Provider } from '../db/schema';
import type { TermsInput } from './connections';

export type BatchAccount = { externalId: string; name: string; officialName?: string | null; mask?: string | null; type: AccountType };
export type BatchBalance = { accountExternalId: string; asOf: string; current: number; available?: number | null; creditLimit?: number | null };
export type BatchTransaction = {
	accountExternalId: string;
	externalId: string;
	pendingExternalId?: string | null;
	postedDate: string;
	transactedAt?: string | null;
	amount: number;
	payeeRaw: string;
	memo?: string | null;
	pending: boolean;
	providerCategory?: string | null;
};
export type BatchRemoval = { accountExternalId: string; externalId: string };
export type BatchTerms = { accountExternalId: string } & Omit<TermsInput, 'source'>;

export type SyncBatch = {
	accounts: BatchAccount[];
	balances: BatchBalance[];
	terms: BatchTerms[];
	added: BatchTransaction[];
	modified: BatchTransaction[];
	removed: BatchRemoval[];
	nextCursor: string | null;
	sendsRemovals: boolean;
	coversFrom: string | null;
};

export type FetchMode = 'full' | 'balances';
export type FetchInput = { credential: string | null; cursor: string | null; mode: FetchMode; todayIso: string };

export interface SyncProvider {
	readonly kind: Provider;
	fetch(input: FetchInput): Promise<SyncBatch>;
}

export class ProviderError extends Error {
	constructor(public readonly code: string, message: string, public readonly needsRelink = false) {
		super(message);
		this.name = 'ProviderError';
	}
}

export function emptyBatch(cursor: string | null): SyncBatch {
	return { accounts: [], balances: [], terms: [], added: [], modified: [], removed: [], nextCursor: cursor, sendsRemovals: false, coversFrom: null };
}
