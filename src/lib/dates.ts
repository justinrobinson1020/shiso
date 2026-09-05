/** All dates are ISO YYYY-MM-DD strings interpreted in UTC. */
export function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export function parseIso(iso: string): Date {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) throw new Error(`invalid ISO date: ${iso}`);
	return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

export function addDays(iso: string, n: number): string {
	const d = parseIso(iso);
	d.setUTCDate(d.getUTCDate() + n);
	return isoDate(d);
}

export function endOfMonth(iso: string): string {
	const d = parseIso(iso);
	return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

export function startOfMonth(iso: string): string {
	return iso.slice(0, 8) + '01';
}

export function compareIso(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Calendar date of `d` in an IANA time zone. en-CA formats as YYYY-MM-DD. */
export function isoDateInZone(d: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Today's calendar date in the app's zone. Budget semantics use this; never `isoDate(new Date())`. */
export function todayIso(timeZone: string): string {
	return isoDateInZone(new Date(), timeZone);
}

export function nowIso(): string {
	return new Date().toISOString();
}
