import type { ParsedFile, ParsedRow } from './types';
import { dollars, statementRowDate, usDateToIso } from './dates';
import { addDays } from '$lib/dates';
const ROW = /^\s*(\d\d\/\d\d(?:\/\d\d)?)\s+(?:(\d\d\/\d\d(?:\/\d\d)?)\s+)?(?:(P[0-9A-Z]{14,})\s+)?(?:(?:Deferred|Standard)\s+)?(.+?)\s+(-?\$[\d,]+\.\d\d)\s*$/;
const HEADINGS: [RegExp, string][] = [
	[/^Payments\b/, 'PAYMENTS'], [/^Purchases( and Other Debits)?\s*$|^Purchases and Other Debits\b/, 'PURCHASES'],
	[/^Total Fees Charged This Period\b/, 'FEES'], [/^Total Interest Charged This Period\b/, 'INTEREST'],
	[/^PAYMENTS & CREDITS\s*$/, 'PAYMENTS'], [/^PURCHASES & ADJUSTMENTS\s*$/, 'PURCHASES'], [/^FEES\s*$/, 'FEES'], [/^INTEREST CHARGED\s*$/, 'INTEREST']
];
const END = /Year-to-Date Fees and Interest|Totals Year-To-Date/i;
export function isSynchronyStatement(text: string): boolean { return /synchrony|SYNCB/i.test(text); }
function need(re: RegExp, text: string, what: string): RegExpExecArray { const m = re.exec(text); if (!m) throw new Error(`synchrony statement: no ${what}`); return m; }
export function parseSynchronyStatement(text: string): ParsedFile {
	const paypal = /Statement Closing Date:/.test(text);
	let opensOn: string, closesOn: string, previousBalance: number, newBalance: number, mask: string | null;
	if (paypal) {
		closesOn = usDateToIso(need(/Statement Closing Date:[ \t]+(\d\d\/\d\d\/\d\d)/, text, 'closing date')[1]);
		const days = +need(/Days in Billing Period:[ \t]+(\d+)/, text, 'days in period')[1];
		opensOn = addDays(closesOn, -(days - 1));
		previousBalance = -dollars(need(/^Previous Balance[ \t]+(-?\$[\d,]+\.\d\d)/m, text, 'previous balance')[1]);
		newBalance = -dollars(need(/^= New Balance[ \t]+(-?\$[\d,]+\.\d\d)/m, text, 'new balance')[1]);
		mask = /Account Number:[ \t]+(?:x{4}[ \t]+){3}(\d{4})/i.exec(text)?.[1] ?? null;
	} else {
		const prev = need(/Previous Balance as of (\d\d\/\d\d\/\d{4})[ \t]+(-?\$[\d,]+\.\d\d)/, text, 'previous balance');
		const nb = need(/New Balance as of (\d\d\/\d\d\/\d{4})[ \t]+(-?\$[\d,]+\.\d\d)/, text, 'new balance');
		opensOn = addDays(usDateToIso(prev[1]), 1); closesOn = usDateToIso(nb[1]);
		previousBalance = -dollars(prev[2]); newBalance = -dollars(nb[2]);
		mask = /Account Number ending in (\d{4})/.exec(text)?.[1] ?? null;
	}
	const rows: ParsedRow[] = []; let section: string | null = null;
	for (const line of text.split(/\r?\n/)) {
		if (END.test(line)) { section = null; continue; }
		const heading = line.trimStart();   // pdftotext -layout indents a column's headings; the `$` anchors still have to bind
		const h = HEADINGS.find(([re]) => re.test(heading)); if (h) { section = h[1]; continue; }
		if (!section) continue;
		const m = ROW.exec(line); if (!m) continue;
		const amount = -dollars(m[5]); if (amount === 0) continue;
		const toIso = (d: string) => (d.length === 8 ? usDateToIso(d) : statementRowDate(d, closesOn));
		const tran = toIso(m[1]); const posted = m[2] ? toIso(m[2]) : tran;
		const desc = m[4].replace(/\s+/g, ' ').trim();
		const promo = /^(.*?)\s+(No Interest If Paid In Full.*)$/i.exec(desc);
		rows.push({ postedDate: posted, transactedAt: paypal ? `${tran}T00:00:00Z` : null, amount, payeeRaw: promo ? promo[1] : desc, memo: promo ? promo[2] : null, providerCategory: section, referenceId: m[3] ? `syf:${m[3]}` : null });
	}
	return { format: 'synchrony', mask, statement: { opensOn, closesOn, previousBalance: previousBalance || 0, newBalance: newBalance || 0 }, rows, balances: [{ asOf: closesOn, current: newBalance || 0 }] };
}
