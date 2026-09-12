import { and, eq, isNull, ne } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accounts, transactions, CASH_TYPES } from '../db/schema';
import { flagForReview, getTransaction, linkTransfer, setSplits } from '../ledger/transactions';
import { paymentCategoryForAccount, uncategorizedId } from '../ledger/categories';
import { parseIso } from '$lib/dates';

export const PAYMENT_HINT = /payment|pymt|pmt|transfer|xfer|autopay|epay|online pay/i;

function dayDiff(a: string, b: string): number {
	return Math.abs((parseIso(a).getTime() - parseIso(b).getTime()) / 86_400_000);
}

/**
 * Spec §5.6 step 3. For each candidate: find the unique equal-and-opposite counterpart on another
 * account inside the window, requiring a cash-type on-budget side. Link both. If the far account is
 * off-budget, categorise the near side to that account's payment category; failing that keep the
 * category a payee rule already gave it (a joint savings account has an envelope, not a payment
 * category); failing that flag it.
 */
export function detectTransfers(db: DbOrTx, candidateIds: number[], opts: { windowDays: number }): { linked: number; flagged: number; categorized: number } {
	const acctById = new Map(db.select().from(accounts).all().map((a) => [a.id, a]));
	const isCash = (id: number) => { const a = acctById.get(id)!; return a.onBudget && (CASH_TYPES as readonly string[]).includes(a.type); };
	let linked = 0, flagged = 0, categorized = 0;

	for (const id of candidateIds) {
		const t = db.select().from(transactions).where(eq(transactions.id, id)).get();
		if (!t || t.deletedAt || t.transferPeerId != null) continue;
		const cands = db.select().from(transactions)
			.where(and(
				eq(transactions.amount, -t.amount), ne(transactions.accountId, t.accountId), ne(transactions.id, id),
				isNull(transactions.transferPeerId), isNull(transactions.deletedAt)
			))
			.all()
			.filter((c) => dayDiff(c.postedDate, t.postedDate) <= opts.windowDays)
			.filter((c) => isCash(t.accountId) || isCash(c.accountId));
		if (cands.length === 0) continue;

		let chosen = cands;
		if (chosen.length > 1) {
			const hinted = chosen.filter((c) => PAYMENT_HINT.test(c.payeeRaw));
			if (hinted.length >= 1) chosen = hinted;
		}
		if (chosen.length > 1) { flagForReview(db, id, 'transfer_ambiguous'); flagged++; continue; }

		const peer = chosen[0];
		// linkTransfer resets both sides to the transfer category; remember what the rules step left so an
		// off-budget pair can keep it.
		const priorSplits = new Map([id, peer.id].map((x) => [x, getTransaction(db, x).splits]));
		linkTransfer(db, id, peer.id);
		linked++;

		// Off-budget far side: the on-budget near side keeps a budget category (§5.6 step 3).
		for (const [near, far] of [[t, peer], [peer, t]] as const) {
			const nearAcct = acctById.get(near.accountId)!, farAcct = acctById.get(far.accountId)!;
			if (!nearAcct.onBudget || farAcct.onBudget) continue;
			const payCat = paymentCategoryForAccount(db, farAcct.id);
			const full = getTransaction(db, near.id);
			const prior = priorSplits.get(near.id)!;
			if (payCat != null) { setSplits(db, near.id, [{ categoryId: payCat, amount: full.amount }]); categorized++; }
			else if (prior.some((s) => s.categoryId !== uncategorizedId(db))) {
				setSplits(db, near.id, prior.map((s) => ({ categoryId: s.categoryId, amount: s.amount, memo: s.memo })));
				categorized++;
			}
			else { flagForReview(db, near.id, 'transfer_off_budget_uncategorized'); flagged++; }
		}
	}
	return { linked, flagged, categorized };
}
