import { parse } from 'csv-parse/sync';
import type { ParsedFile, ParsedRow } from './types';
import { dollars, usDateToIso } from './dates';
import { isoDate, parseIso } from '$lib/dates';
/** Capital One exports ISO dates today and MM/DD/YYYY historically; anything else (or an impossible ISO date) is not a date. */
function csvDate(s: string): string {
	const t = s.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return usDateToIso(t);
	if (isoDate(parseIso(t)) !== t) throw new Error(`bad date: ${s}`);   // parseIso rolls 2026-13-01 over into 2027-01-01
	return t;
}
export const CAPITAL_ONE_HEADER = ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'] as const;
export function parseCapitalOneCsv(text: string): ParsedFile {
	const records = parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Record<string, string>[];
	const header = records.length ? Object.keys(records[0]) : (text.split(/\r?\n/)[0]?.split(',') ?? []);
	if (!CAPITAL_ONE_HEADER.every((c) => header.includes(c))) throw new Error('unrecognised CSV header: expected Capital One export columns');
	const rows: ParsedRow[] = records.map((r) => ({
		postedDate: csvDate(r['Posted Date'] ?? ''), transactedAt: r['Transaction Date'] ? `${csvDate(r['Transaction Date'])}T00:00:00Z` : null,
		amount: dollars(r['Credit'] || '0') - dollars(r['Debit'] || '0'),
		payeeRaw: r['Description'], memo: null, providerCategory: r['Category'] || null, referenceId: null
	})).filter((r) => r.amount !== 0).reverse();
	return { format: 'capital_one', mask: records[0]?.['Card No.'] || null, statement: null, rows, balances: [] };
}
