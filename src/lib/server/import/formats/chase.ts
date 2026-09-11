import type { ParsedFile, ParsedRow } from './types';
import { dollars, statementRowDate, usDateToIso } from './dates';
const ROW = /^\s*(\d\d\/\d\d)\s+(.+?)\s+(-?[\d,]+\.\d\d)\s*$/;
const SECTIONS = new Set(['PAYMENTS AND OTHER CREDITS', 'PURCHASE', 'FEES CHARGED', 'INTEREST CHARGED']);
export function isChaseStatement(text: string): boolean { return /chase\.com/i.test(text) && /Opening\/Closing Date/.test(text); }
function money(re: RegExp, text: string, what: string): number { const m = re.exec(text); if (!m) throw new Error(`chase statement: no ${what}`); return dollars(m[1]); }
export function parseChaseStatement(text: string): ParsedFile {
	const oc = /Opening\/Closing Date[ \t]+(\d\d\/\d\d\/\d\d)[ \t]*-[ \t]*(\d\d\/\d\d\/\d\d)/.exec(text);
	if (!oc) throw new Error('chase statement: no Opening/Closing Date');
	const opensOn = usDateToIso(oc[1]), closesOn = usDateToIso(oc[2]);
	const previousBalance = -money(/^[ \t]*Previous Balance[ \t]+(-?\$[\d,]+\.\d\d)/m, text, 'Previous Balance') || 0;
	const newBalance = -money(/^[ \t]*New Balance[ \t]+(-?\$[\d,]+\.\d\d)[ \t]*$/m, text, 'New Balance') || 0;
	const mask = /Account Number:[ \t]+(?:X{4}[ \t]+){3}(\d{4})/.exec(text)?.[1] ?? null;
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((l) => l.includes('ACCOUNT ACTIVITY'));
	const rows: ParsedRow[] = [];
	if (start >= 0) {
		let section: string | null = null;
		for (let i = start + 1; i < lines.length; i++) {
			const line = lines[i]; if (line.includes('Totals Year-to-Date')) break;
			const t = line.trim(); if (SECTIONS.has(t)) { section = t; continue; }
			const m = ROW.exec(line); if (!m) continue;
			const amount = -dollars(m[3]); if (amount === 0) continue;
			rows.push({ postedDate: statementRowDate(m[1], closesOn), transactedAt: null, amount, payeeRaw: m[2].replace(/\s+/g, ' ').trim(), memo: null, providerCategory: section, referenceId: null });
		}
	}
	return { format: 'chase', mask, statement: { opensOn, closesOn, previousBalance, newBalance }, rows, balances: [{ asOf: closesOn, current: newBalance }] };
}
