import type { Db } from '../../db';
import { ensurePeriods, periodBoundsFor, nextPeriodStart, type Cadence } from '../../budget/periods';
import { createTransaction } from '../../ledger/transactions';
import { InvariantError } from '../../ledger/errors';
import { contentHash, normalizeDescription } from '../hash';
import { compareIso } from '$lib/dates';
import { parseAppleCardCsv } from '../../import/formats/apple';

export function importCsv(db: Db, accountId: number, text: string, opts: { cadence: Cadence; todayIso: string }): { created: number; duplicates: number; ids: number[] } {
	const parsed = parseAppleCardCsv(text);
	const rows = parsed.rows;
	if (rows.length === 0) return { created: 0, duplicates: 0, ids: [] };
	const earliest = rows.map((r) => r.postedDate).reduce((m, d) => (compareIso(d, m) < 0 ? d : m));
	const next = periodBoundsFor(opts.cadence, nextPeriodStart(opts.cadence, periodBoundsFor(opts.cadence, opts.todayIso).endDate));
	ensurePeriods(db, opts.cadence, earliest, next.endDate);

	const seen = new Map<string, number>();
	let created = 0, duplicates = 0;
	const ids: number[] = [];
	db.transaction((tx) => {
		for (const r of rows) {
			const key = `${r.postedDate}|${r.amount}|${normalizeDescription(r.memo ?? r.payeeRaw)}`;
			const ordinal = seen.get(key) ?? 0;
			seen.set(key, ordinal + 1);
			const externalId = contentHash({ accountKey: `csv:${accountId}`, date: r.postedDate, amount: r.amount, description: r.memo ?? r.payeeRaw, ordinal });
			try {
				ids.push(createTransaction(tx, { accountId, externalId, postedDate: r.postedDate, transactedAt: r.transactedAt, amount: r.amount, payeeRaw: r.payeeRaw, memo: r.memo, providerCategory: r.providerCategory, source: 'import' }));
				created++;
			} catch (err) {
				if (err instanceof InvariantError && err.code === 'DUPLICATE_EXTERNAL_ID') duplicates++;
				else throw err;
			}
		}
	});
	return { created, duplicates, ids };
}
