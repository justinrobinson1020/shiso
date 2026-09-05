/** Parse a decimal string or number into integer cents. Throws on invalid input. */
export function decimalToCents(input: string | number): number {
	let s = typeof input === 'number' ? input.toFixed(2) : input.trim();
	let negative = false;
	if (s.startsWith('(') && s.endsWith(')')) {
		negative = true;
		s = s.slice(1, -1);
	}
	s = s.replace(/[$,\s]/g, '');
	if (s.startsWith('-')) {
		negative = !negative;
		s = s.slice(1);
	}
	const m = /^(\d*)(?:\.(\d{1,2}))?$/.exec(s);
	if (!m || (m[1] === '' && m[2] === undefined)) {
		throw new Error(`invalid money value: ${JSON.stringify(input)}`);
	}
	const whole = m[1] === '' ? 0 : parseInt(m[1], 10);
	const frac = m[2] === undefined ? 0 : parseInt(m[2].padEnd(2, '0'), 10);
	const cents = whole * 100 + frac;
	return negative ? -cents : cents;
}

/** Format integer cents as a US dollar string. */
export function formatCents(cents: number): string {
	const sign = cents < 0 ? '-' : '';
	const abs = Math.abs(cents);
	const whole = Math.floor(abs / 100).toLocaleString('en-US');
	const frac = String(abs % 100).padStart(2, '0');
	return `${sign}$${whole}.${frac}`;
}
