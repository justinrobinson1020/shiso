import { contentHash } from '../hash';
import { ProviderError, type BatchAccount, type BatchBalance, type BatchTransaction, type FetchInput, type SyncBatch, type SyncProvider } from '../types';
import { decimalToCents } from '$lib/money';
import { addDays, parseIso } from '$lib/dates';

type SfTransaction = { id?: string; posted: number; amount: string; description: string; transacted_at?: number; pending?: boolean };
type SfAccount = { id: string; name: string; currency?: string; balance: string; 'available-balance'?: string; 'balance-date': number; org?: { name?: string }; transactions?: SfTransaction[] };
type SfResponse = { errors?: string[]; accounts: SfAccount[] };

const unixDate = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 10);

export function splitAccessUrl(accessUrl: string): { base: string; authorization: string } {
	const u = new URL(accessUrl);
	const authorization = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
	u.username = ''; u.password = '';
	return { base: u.toString().replace(/\/$/, ''), authorization };
}

export async function claimSetupToken(setupToken: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<string> {
	const claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8');
	if (!/^https?:\/\//.test(claimUrl)) throw new ProviderError('SIMPLEFIN_BAD_SETUP_TOKEN', 'setup token did not decode to a URL');
	const res = await fetchImpl(claimUrl, { method: 'POST' });
	if (!res.ok) throw new ProviderError(`SIMPLEFIN_HTTP_${res.status}`, `claim failed with HTTP ${res.status}`);
	return (await res.text()).trim();
}

export class SimpleFinProvider implements SyncProvider {
	readonly kind = 'simplefin' as const;
	private readonly lookbackDays: number;
	private readonly initialDays: number;
	constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch, opts: { lookbackDays?: number; initialDays?: number } = {}) {
		this.lookbackDays = opts.lookbackDays ?? 7;
		this.initialDays = opts.initialDays ?? 90;
	}

	async fetch(input: FetchInput): Promise<SyncBatch> {
		if (!input.credential) throw new ProviderError('NO_CREDENTIAL', 'connection has no access URL', true);
		const { base, authorization } = splitAccessUrl(input.credential);
		const startIso = input.cursor ? addDays(input.cursor, -this.lookbackDays) : addDays(input.todayIso, -this.initialDays);
		const startUnix = Math.floor(parseIso(startIso).getTime() / 1000);
		const url = input.mode === 'balances'
			? `${base}/accounts?balances-only=1`
			: `${base}/accounts?start-date=${startUnix}&pending=1`;
		const res = await this.fetchImpl(url, { headers: { Authorization: authorization, Accept: 'application/json' } });
		if (res.status === 401 || res.status === 403) throw new ProviderError(`SIMPLEFIN_HTTP_${res.status}`, 'access URL rejected; claim a new setup token', true);
		if (!res.ok) throw new ProviderError(`SIMPLEFIN_HTTP_${res.status}`, `SimpleFIN returned HTTP ${res.status}`);
		const data = (await res.json()) as SfResponse;
		if (data.errors && data.errors.length) throw new ProviderError('SIMPLEFIN_ERRORS', data.errors.join('; '));

		const accounts: BatchAccount[] = [];
		const balances: BatchBalance[] = [];
		const added: BatchTransaction[] = [];
		for (const a of data.accounts) {
			const current = decimalToCents(a.balance);
			accounts.push({ externalId: a.id, name: a.name, officialName: a.org?.name ?? null, mask: null, type: current < 0 ? 'credit' : 'checking' });
			balances.push({ accountExternalId: a.id, asOf: input.todayIso, current, available: a['available-balance'] != null ? decimalToCents(a['available-balance']) : null, creditLimit: null });
			if (input.mode !== 'balances') {
				const seen = new Map<string, number>();
				for (const t of a.transactions ?? []) {
					const amount = decimalToCents(t.amount);
					const pending = t.pending ?? t.posted === 0;
					const postedDate = t.posted ? unixDate(t.posted) : unixDate(t.transacted_at ?? Math.floor(Date.now() / 1000));
					let externalId = t.id?.trim() || '';
					if (!externalId) {
						const key = `${postedDate}|${amount}|${t.description}`;
						const ordinal = seen.get(key) ?? 0;
						seen.set(key, ordinal + 1);
						externalId = contentHash({ accountKey: a.id, date: postedDate, amount, description: t.description, ordinal });
					}
					added.push({
						accountExternalId: a.id, externalId, postedDate, transactedAt: t.transacted_at ? new Date(t.transacted_at * 1000).toISOString() : null,
						amount, payeeRaw: t.description, pending, providerCategory: null
					});
				}
			}
		}
		return {
			accounts, balances, terms: [], added, modified: [], removed: [],
			nextCursor: input.mode === 'balances' ? input.cursor : input.todayIso,
			sendsRemovals: false,
			coversFrom: input.mode === 'balances' ? null : startIso
		};
	}
}
