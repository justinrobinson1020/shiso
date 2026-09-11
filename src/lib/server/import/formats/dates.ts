import { decimalToCents } from '$lib/money';
export function usDateToIso(s: string): string {
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s.trim());
	if (!m) throw new Error(`bad date: ${s}`);
	const y = m[3].length === 4 ? +m[3] : 2000 + +m[3];
	return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
/** Chase and Synchrony print MM/DD; the year is the closing date's, one less when the month is later than the closing month. */
export function statementRowDate(mmdd: string, closesOn: string): string {
	const m = /^(\d\d)\/(\d\d)$/.exec(mmdd); if (!m) throw new Error(`bad row date: ${mmdd}`);
	const closeYear = +closesOn.slice(0, 4), closeMonth = +closesOn.slice(5, 7);
	const year = +m[1] > closeMonth ? closeYear - 1 : closeYear;
	return `${year}-${m[1]}-${m[2]}`;
}
export function dollars(s: string): number { return decimalToCents(s.replace(/[$,\s]/g, '')); }
