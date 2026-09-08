import { parse } from 'csv-parse/sync';
import type { Db } from '../../db';
import { ensurePeriods, periodBoundsFor, nextPeriodStart, type Cadence } from '../../budget/periods';
import { createTransaction } from '../../ledger/transactions';
import { InvariantError } from '../../ledger/errors';
import { contentHash, normalizeDescription } from '../hash';
import { decimalToCents } from '$lib/money';
import { compareIso } from '$lib/dates';

export type ParsedRow = { postedDate: string; transactedAt: string | null; amount: number; payeeRaw: string; memo: string | null; providerCategory: string | null };

const REQUIRED = ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)'];

function usDateToIso(s: string): string {
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
	if (!m) throw new Error(`bad date: ${s}`);
	return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export function parseAppleCardCsv(text: string): ParsedRow[] {
	const records = parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Record<string, string>[];
	const header = records.length ? Object.keys(records[0]) : text.split(/\r?\n/)[0]?.split(',') ?? [];
	if (!REQUIRED.every((c) => header.includes(c))) throw new Error('unrecognised CSV header: expected Apple Card export columns');
	return records.map((r) => {
		const description = r['Description'].trim();
		const merchant = r['Merchant'].trim();
		return {
			postedDate: usDateToIso(r['Clearing Date']),
			transactedAt: r['Transaction Date'] ? `${usDateToIso(r['Transaction Date'])}T00:00:00Z` : null,
			amount: -decimalToCents(r['Amount (USD)']),
			payeeRaw: merchant || description,
			memo: merchant && description !== merchant ? description : null,
			providerCategory: r['Category']?.trim() || null
		};
	});
}

export function importCsv(db: Db, accountId: number, text: string, opts: { cadence: Cadence; todayIso: string }): { created: number; duplicates: number; ids: number[] } {
	const rows = parseAppleCardCsv(text);
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
