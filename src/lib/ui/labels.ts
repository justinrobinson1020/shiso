/**
 * Display words for stored enum values (cadences, category kinds, connection statuses, providers, sources, review
 * reasons). The stored values never change; a value without an entry reads with its underscores as spaces.
 */
const LABELS: Record<string, string> = {
	semi_monthly: 'twice a month',
	every_n_weeks: 'every few weeks',
	debt_payment: 'debt payment',
	needs_relink: 'needs relink',
	plaid: 'Plaid',
	simplefin: 'SimpleFIN',
	provider: 'synced',
	amount_changed: 'amount changed',
	transfer_peer_deleted: 'other side deleted',
	transfer_unlinked: 'transfer unlinked'
};

export const label = (value: string | null | undefined): string => (value == null ? '' : (LABELS[value] ?? value.replaceAll('_', ' ')));

/** What a review reason means and what clearing it confirms, for the Ledger's review chip. */
export const REVIEW_HELP: Record<string, string> = {
	amount_changed: 'The bank changed this amount after it was categorized. Check the split, then clear.',
	transfer_peer_deleted: 'The other half of this transfer was deleted. Recategorize it, then clear.',
	transfer_unlinked: 'This was unlinked from its transfer. Give it a category, then clear.'
};
