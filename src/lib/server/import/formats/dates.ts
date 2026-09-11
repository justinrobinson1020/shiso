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
export function dollars(s: string): number {
	const normalized = s.replace(/[$,\s]/g, '');
	const [intPart, fracPart] = normalized.split('.');
	const result = !fracPart || fracPart.length <= 2 ? decimalToCents(normalized) : (() => {
		// Round fractional part to 2 digits: round half-up on the third digit
		const firstTwoDigits = parseInt(fracPart.slice(0, 2), 10);
		const thirdDigit = parseInt(fracPart[2], 10);
		let roundedFraction = firstTwoDigits;
		if (thirdDigit >= 5) roundedFraction += 1;
		if (roundedFraction >= 100) {
			// Carry over to integer part
			const intValue = parseInt(intPart || '0', 10);
			const isNegative = intPart.startsWith('-');
			const absIntValue = Math.abs(intValue);
			const newAbsInt = absIntValue + 1;
			const newInt = isNegative ? -newAbsInt : newAbsInt;
			return decimalToCents(`${newInt}.00`);
		}
		const normalizedStr = `${intPart}.${String(roundedFraction).padStart(2, '0')}`;
		return decimalToCents(normalizedStr);
	})();
	// Normalize -0 to 0
	return result === 0 ? 0 : result;
}
