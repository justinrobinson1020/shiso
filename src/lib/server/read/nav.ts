import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { transactions } from '../db/schema';
import { driftReport } from '../reconcile';

/** §8 Ledger: the review queue is flagged live rows plus accounts whose provider balance disagrees with the ledger. */
export function reviewCount(db: DbOrTx): number {
	const flagged = db.select({ n: sql<number>`count(*)` }).from(transactions)
		.where(and(eq(transactions.needsReview, true), isNull(transactions.deletedAt))).get()?.n ?? 0;
	const drifted = driftReport(db).filter((d) => d.drift != null && d.drift !== 0).length;
	return flagged + drifted;
}
