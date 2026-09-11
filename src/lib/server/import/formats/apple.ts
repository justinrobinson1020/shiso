import { parse } from 'csv-parse/sync';
import { usDateToIso } from './dates';
import { decimalToCents } from '$lib/money';
import type { ParsedFile } from './types';

export const APPLE_HEADER = ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)'] as const;

export function parseAppleCardCsv(text: string): ParsedFile {
	const records = parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Record<string, string>[];
	const header = records.length ? Object.keys(records[0]) : text.split(/\r?\n/)[0]?.split(',') ?? [];
	if (!APPLE_HEADER.every((c) => header.includes(c))) throw new Error('unrecognised CSV header: expected Apple Card export columns');
	return {
		format: 'apple',
		mask: null,
		statement: null,
		balances: [],
		rows: records.map((r) => {
			const description = r['Description'].trim();
			const merchant = r['Merchant'].trim();
			return {
				postedDate: usDateToIso(r['Clearing Date']),
				transactedAt: r['Transaction Date'] ? `${usDateToIso(r['Transaction Date'])}T00:00:00Z` : null,
				amount: -decimalToCents(r['Amount (USD)']),
				payeeRaw: merchant || description,
				memo: merchant && description !== merchant ? description : null,
				providerCategory: r['Category']?.trim() || null,
				referenceId: null
			};
		})
	};
}
