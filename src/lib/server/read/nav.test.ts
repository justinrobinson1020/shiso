import { describe, it, expect } from 'vitest';
import { fixture } from '../test/fixture';
import { createTransaction, flagForReview } from '../ledger/transactions';
import { appendBalance } from '../sync/connections';
import { reviewCount } from './nav';

describe('reviewCount', () => {
	it('counts flagged rows plus accounts with drift', () => {
		const f = fixture();
		expect(reviewCount(f.db)).toBe(0);
		const id = createTransaction(f.db, { accountId: f.checking, externalId: 't1', postedDate: '2026-09-02', amount: -1000, payeeRaw: 'X', source: 'manual' });
		flagForReview(f.db, id, 'transfer_unlinked');
		expect(reviewCount(f.db)).toBe(1);
		appendBalance(f.db, f.checking, { asOf: '2026-09-08', current: 500, source: 'manual' }); // ledger says -1000
		expect(reviewCount(f.db)).toBe(2);
	});
});
