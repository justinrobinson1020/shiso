import { parse } from 'csv-parse/sync';
import { ImportError, type ParsedBalance, type ParsedFile, type ParsedRow } from './types';
import { usDateToIso } from './dates';
export const NASA_HEADER = ['Transaction ID', 'Posting Date', 'Effective Date', 'Amount', 'Description', 'Balance'] as const;
export function parseNasaFcuCsv(text: string): ParsedFile {
	const records = parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Record<string, string>[];
	const header = records.length ? Object.keys(records[0]) : (text.split(/\r?\n/)[0]?.replace(/"/g, '').split(',') ?? []);
	if (!NASA_HEADER.every((c) => header.includes(c))) throw new Error('unrecognised CSV header: expected NASA FCU export columns');
	// File order is newest first; each row's Balance is the balance after it.
	const parsed = records.map((r) => ({
		postedDate: usDateToIso(r['Posting Date']), transactedAt: r['Effective Date'] ? `${usDateToIso(r['Effective Date'])}T00:00:00Z` : null,
		amount: Math.round(parseFloat(r['Amount']) * 100), balance: Math.round(parseFloat(r['Balance']) * 100), payeeRaw: r['Description'],
		memo: r['Extended Description'] && r['Extended Description'] !== r['Description'] ? r['Extended Description'] : null,
		providerCategory: r['Transaction Category'] || null, referenceId: `nasa:${r['Transaction ID']}`, raw: r
	}));
	for (let i = 0; i + 1 < parsed.length; i++) {
		const cur = parsed[i], prev = parsed[i + 1];
		if (prev.balance + cur.amount !== cur.balance)
			throw new ImportError('reconcile', `does not reconcile at ${cur.raw['Posting Date']} ${cur.payeeRaw}: balance ${cur.balance} ≠ previous ${prev.balance} + amount ${cur.amount}`);
	}
	const balances: ParsedBalance[] = []; const months = new Set<string>();
	for (const p of parsed) { const ym = p.postedDate.slice(0, 7); if (!months.has(ym)) { months.add(ym); balances.push({ asOf: p.postedDate, current: p.balance }); } }
	const rows: ParsedRow[] = parsed.filter((p) => p.amount !== 0).map(({ balance: _b, raw: _r, ...row }) => row).reverse();
	return { format: 'nasa_fcu', mask: null, statement: null, rows, balances: balances.reverse() };
}
