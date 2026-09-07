import { CASH_TYPES, type AccountType, type CategoryKind, type TransactionSource } from '../db/schema';

export type EnvAccount = { id: number; type: AccountType; onBudget: boolean };
export type EnvCategory = { id: number; kind: CategoryKind; accountId: number | null };
export type EnvPeriod = { id: number; startDate: string };
export type EnvSplit = {
	transactionId: number; accountId: number; periodId: number; categoryId: number;
	amount: number; transferPeerAccountId: number | null; source: TransactionSource;
};
export type EnvAssignment = { periodId: number; categoryId: number; assigned: number };
export type EnvBalance = { accountId: number; current: number };
export type BudgetInput = {
	accounts: EnvAccount[]; categories: EnvCategory[]; periods: EnvPeriod[];
	splits: EnvSplit[]; assignments: EnvAssignment[]; balances: EnvBalance[];
};
export type CategoryPeriod = {
	carried: number; assigned: number; activity: number; available: number;
	creditOverspend: number; cashOverspend: number;
};
export type BudgetResult = {
	byPeriod: Map<number, Map<number, CategoryPeriod>>;
	readyToAssign: number;
	readyToAssignFromFlows: number;
	underfunded: Map<number, number>;
	cardBalanceOwed: Map<number, number>;
};

/** §7.2: the kinds that never get an envelope. The single definition; assign() imports it. */
export const NO_ENVELOPE_KINDS: ReadonlySet<CategoryKind> = new Set(['income', 'transfer', 'reconciliation']);

/** §4.1: the only accounts whose cash counts toward ready-to-assign. */
export function isCashAccount(a: EnvAccount): boolean {
	return a.onBudget && (CASH_TYPES as readonly string[]).includes(a.type);
}

const key2 = (a: number, b: number) => `${a}:${b}`;
const key3 = (a: number, b: number, c: number) => `${a}:${b}:${c}`;
const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/** Distribute `total` across `weights` proportionally with largest-remainder rounding. */
function apportion(total: number, weights: Map<number, number>): Map<number, number> {
	const out = new Map<number, number>();
	const sum = [...weights.values()].reduce((s, w) => s + w, 0);
	if (total === 0 || sum === 0) return out;
	let allocated = 0;
	const rem: { id: number; frac: number }[] = [];
	for (const [id, w] of weights) {
		const exact = (total * w) / sum;
		const floor = Math.floor(exact);
		out.set(id, floor);
		allocated += floor;
		rem.push({ id, frac: exact - floor });
	}
	rem.sort((a, b) => b.frac - a.frac);
	for (let i = 0; allocated < total && i < rem.length; i++, allocated++) {
		out.set(rem[i].id, out.get(rem[i].id)! + 1);
	}
	return out;
}

export function computeBudget(input: BudgetInput, currentPeriodId: number): BudgetResult {
	const periods = [...input.periods].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
	const periodIndex = new Map(periods.map((p, i) => [p.id, i]));
	if (!periodIndex.has(currentPeriodId)) throw new Error(`period ${currentPeriodId} not in input`);
	const currentIdx = periodIndex.get(currentPeriodId)!;

	const cashIds = new Set(input.accounts.filter(isCashAccount).map((a) => a.id));
	const onBudgetIds = new Set(input.accounts.filter((a) => a.onBudget).map((a) => a.id));
	const cardIds = new Set(input.accounts.filter((a) => a.onBudget && a.type === 'credit').map((a) => a.id));

	const kindById = new Map(input.categories.map((c) => [c.id, c.kind]));
	const isCardEnvelope = (c: EnvCategory) => c.kind === 'debt_payment' && c.accountId != null && cardIds.has(c.accountId);
	const isSpendingLike = (c: EnvCategory) => !NO_ENVELOPE_KINDS.has(c.kind) && !isCardEnvelope(c);
	const spendingLike = input.categories.filter(isSpendingLike);
	const cardEnvelopes = input.categories.filter(isCardEnvelope);

	// ---- index the ledger ------------------------------------------------
	const splitsByPC = new Map<string, number>();       // period:category → Σ amount on on-budget accounts
	const cardSplitsByPCX = new Map<string, number>();  // period:category:card → Σ amount on that card
	const paymentsByPX = new Map<string, number>();     // period:card → Σ payments from cash to card (positive)
	const cashInflowsByP = new Map<number, number>();   // period → opening + adjustment + income on cash accounts
	const cardOwedAll = new Map<number, number>();      // card → −Σ amounts (balance owed) from splits
	for (const s of input.splits) {
		if (onBudgetIds.has(s.accountId)) bump(splitsByPC, key2(s.periodId, s.categoryId), s.amount);
		if (cardIds.has(s.accountId)) {
			bump(cardSplitsByPCX, key3(s.periodId, s.categoryId, s.accountId), s.amount);
			cardOwedAll.set(s.accountId, (cardOwedAll.get(s.accountId) ?? 0) - s.amount);
		}
		if (cashIds.has(s.accountId) && s.transferPeerAccountId != null && cardIds.has(s.transferPeerAccountId)) {
			bump(paymentsByPX, key2(s.periodId, s.transferPeerAccountId), -s.amount);
		}
		if (cashIds.has(s.accountId)) {
			if (s.source === 'opening' || s.source === 'adjustment' || kindById.get(s.categoryId) === 'income') {
				cashInflowsByP.set(s.periodId, (cashInflowsByP.get(s.periodId) ?? 0) + s.amount);
			}
		}
	}
	const assignedByPC = new Map<string, number>();
	const assignedByP = new Map<number, number>();
	for (const a of input.assignments) {
		bump(assignedByPC, key2(a.periodId, a.categoryId), a.assigned);
		assignedByP.set(a.periodId, (assignedByP.get(a.periodId) ?? 0) + a.assigned);
	}

	// ---- walk periods in order --------------------------------------------
	const byPeriod = new Map<number, Map<number, CategoryPeriod>>();
	const carried = new Map<number, number>();
	const cashOverspendByP = new Map<number, number>();

	for (const p of periods) {
		const row = new Map<number, CategoryPeriod>();
		const creditOsOnCard = new Map<number, number>();   // card → Σ credit overspend attributed this period
		let cashOsTotal = 0;

		// Pass 1: spending-like categories (§7.1, §7.2 first bullet)
		for (const c of spendingLike) {
			const carry = carried.get(c.id) ?? 0;
			const assigned = assignedByPC.get(key2(p.id, c.id)) ?? 0;
			const activity = splitsByPC.get(key2(p.id, c.id)) ?? 0;
			const gross = carry + assigned + activity;
			const overspend = Math.max(0, -gross);
			const purchasesByCard = new Map<number, number>();
			let cardNet = 0;
			for (const x of cardIds) {
				const cs = cardSplitsByPCX.get(key3(p.id, c.id, x)) ?? 0;
				cardNet += cs;
				if (cs < 0) purchasesByCard.set(x, -cs);
			}
			const creditOverspend = Math.min(overspend, Math.max(0, -cardNet));
			const cashOverspend = overspend - creditOverspend;
			for (const [x, share] of apportion(creditOverspend, purchasesByCard)) {
				creditOsOnCard.set(x, (creditOsOnCard.get(x) ?? 0) + share);
			}
			cashOsTotal += cashOverspend;
			row.set(c.id, { carried: carry, assigned, activity, available: gross, creditOverspend, cashOverspend });
			carried.set(c.id, Math.max(0, gross));
		}

		// Pass 2: card payment envelopes (§7.2 second bullet)
		for (const c of cardEnvelopes) {
			const x = c.accountId!;
			const carry = carried.get(c.id) ?? 0;
			const assigned = assignedByPC.get(key2(p.id, c.id)) ?? 0;
			let moneyIn = 0;
			for (const sc of spendingLike) moneyIn -= cardSplitsByPCX.get(key3(p.id, sc.id, x)) ?? 0;
			const activity = moneyIn - (creditOsOnCard.get(x) ?? 0) - (paymentsByPX.get(key2(p.id, x)) ?? 0);
			const available = carry + assigned + activity;
			row.set(c.id, { carried: carry, assigned, activity, available, creditOverspend: 0, cashOverspend: 0 });
			carried.set(c.id, available);
		}

		cashOverspendByP.set(p.id, cashOsTotal);
		byPeriod.set(p.id, row);
	}

	// ---- §7.3 ready to assign from balances --------------------------------
	const cash = input.balances.filter((b) => cashIds.has(b.accountId)).reduce((s, b) => s + b.current, 0);
	const current = byPeriod.get(currentPeriodId)!;
	let positiveAvailable = 0;
	let negativeCardEnvelopes = 0;
	for (const c of input.categories) {
		const cp = current.get(c.id);
		if (!cp) continue;
		positiveAvailable += Math.max(0, cp.available);
		if (isCardEnvelope(c)) negativeCardEnvelopes += Math.max(0, -cp.available);
	}
	let futureAssigned = 0;
	for (const p of periods) if (periodIndex.get(p.id)! > currentIdx) futureAssigned += assignedByP.get(p.id) ?? 0;
	const readyToAssign = cash - positiveAvailable - futureAssigned;

	// ---- §7.5 ready to assign from flows ------------------------------------
	let inflows = 0, assignedThrough = 0, cashOsThrough = 0;
	for (const p of periods) {
		if (periodIndex.get(p.id)! > currentIdx) continue;
		inflows += cashInflowsByP.get(p.id) ?? 0;
		assignedThrough += assignedByP.get(p.id) ?? 0;
		cashOsThrough += cashOverspendByP.get(p.id) ?? 0;
	}
	const readyToAssignFromFlows = inflows - assignedThrough - cashOsThrough - negativeCardEnvelopes - futureAssigned;

	// ---- §7.4 card underfunding ---------------------------------------------
	const underfunded = new Map<number, number>();
	const cardBalanceOwed = new Map<number, number>();
	for (const c of cardEnvelopes) {
		const x = c.accountId!;
		const bal = input.balances.find((b) => b.accountId === x);
		const owed = bal ? -bal.current : (cardOwedAll.get(x) ?? 0);
		cardBalanceOwed.set(x, owed);
		underfunded.set(x, Math.max(0, owed - current.get(c.id)!.available));
	}

	return { byPeriod, readyToAssign, readyToAssignFromFlows, underfunded, cardBalanceOwed };
}
