import { describe, it, expect } from 'vitest';
import { SimpleFinProvider, claimSetupToken, splitAccessUrl } from './simplefin';

const unix = (iso: string) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000);

const body = {
	errors: [],
	accounts: [
		{ id: 'A1', name: 'Everyday', currency: 'USD', balance: '1234.56', 'available-balance': '1200.00', 'balance-date': 1757289600, org: { name: 'Bank' },
		  transactions: [
			{ id: 'T1', posted: unix('2026-09-07'), amount: '-45.10', description: 'GROCER' },
			{ id: '', posted: 0, amount: '-9.99', description: 'Coffee', transacted_at: unix('2026-09-08'), pending: true },
			{ id: '', posted: 0, amount: '-9.99', description: 'Coffee', transacted_at: unix('2026-09-08'), pending: true }
		  ] },
		{ id: 'C1', name: 'Store Card', currency: 'USD', balance: '-857.25', 'balance-date': 1757289600, org: { name: 'Synchrony' }, transactions: [] }
	]
};
function fakeFetch(json: unknown, status = 200) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const f = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response(typeof json === 'string' ? json : JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return { f, calls };
}

describe('SimpleFinProvider', () => {
	it('sends basic auth, a start date, maps accounts and transactions, hashes id-less rows', async () => {
		const { f, calls } = fakeFetch(body);
		const b = await new SimpleFinProvider(f).fetch({ credential: 'https://user:pw@bridge.simplefin.org/simplefin', cursor: '2026-09-07', mode: 'full', todayIso: '2026-09-08' });
		expect(calls[0].url).toBe(`https://bridge.simplefin.org/simplefin/accounts?start-date=${unix('2026-08-31')}&pending=1`); // 2026-08-31T00:00:00Z
		expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe('Basic ' + Buffer.from('user:pw').toString('base64'));
		expect(b.accounts).toEqual([
			{ externalId: 'A1', name: 'Everyday', officialName: 'Bank', mask: null, type: 'checking' },
			{ externalId: 'C1', name: 'Store Card', officialName: 'Synchrony', mask: null, type: 'credit' }
		]);
		expect(b.balances[0]).toEqual({ accountExternalId: 'A1', asOf: '2026-09-08', current: 123456, available: 120000, creditLimit: null });
		expect(b.added[0]).toMatchObject({ accountExternalId: 'A1', externalId: 'T1', amount: -4510, postedDate: '2026-09-07', pending: false });
		expect(b.added[1].externalId).toMatch(/^h1:/);
		expect(b.added[1]).toMatchObject({ amount: -999, postedDate: '2026-09-08', pending: true });
		expect(b.added[2].externalId).not.toBe(b.added[1].externalId);
		expect(b).toMatchObject({ nextCursor: '2026-09-08', sendsRemovals: false, coversFrom: '2026-08-31' });
	});
	it('uses the initial window without a cursor and balances-only in balances mode', async () => {
		const { f, calls } = fakeFetch(body);
		const p = new SimpleFinProvider(f, { initialDays: 90 });
		await p.fetch({ credential: 'https://u:p@h/simplefin', cursor: null, mode: 'full', todayIso: '2026-09-08' });
		expect(calls[0].url).toContain(`start-date=${unix('2026-06-10')}`); // 2026-06-10
		const b = await p.fetch({ credential: 'https://u:p@h/simplefin', cursor: '2026-09-07', mode: 'balances', todayIso: '2026-09-08' });
		expect(calls[1].url).toContain('balances-only=1');
		expect(b.added).toEqual([]);
		expect(b.nextCursor).toBe('2026-09-07');
	});
	it('maps HTTP 403 to a relink error and other failures to ProviderError', async () => {
		await expect(new SimpleFinProvider(fakeFetch('denied', 403).f).fetch({ credential: 'https://u:p@h/simplefin', cursor: null, mode: 'full', todayIso: '2026-09-08' }))
			.rejects.toMatchObject({ needsRelink: true });
		await expect(new SimpleFinProvider(fakeFetch('oops', 500).f).fetch({ credential: 'https://u:p@h/simplefin', cursor: null, mode: 'full', todayIso: '2026-09-08' }))
			.rejects.toMatchObject({ code: 'SIMPLEFIN_HTTP_500' });
	});
	it('claims a setup token and splits credentials out of the access URL', async () => {
		const claimUrl = 'https://bridge.simplefin.org/simplefin/claim/abc';
		const { f, calls } = fakeFetch('https://user:pw@bridge.simplefin.org/simplefin');
		const access = await claimSetupToken(Buffer.from(claimUrl).toString('base64'), f);
		expect(calls[0]).toMatchObject({ url: claimUrl, init: { method: 'POST' } });
		expect(access).toBe('https://user:pw@bridge.simplefin.org/simplefin');
		expect(splitAccessUrl(access)).toEqual({ base: 'https://bridge.simplefin.org/simplefin', authorization: 'Basic ' + Buffer.from('user:pw').toString('base64') });
	});
});
