import { cents, isoDate, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { getConfig } from '$lib/server/config';
import { generateOccurrences } from '$lib/server/bills/schedule';
import { getSetting } from '$lib/server/settings';
import { todayIso } from '$lib/dates';
import { BILL_CADENCES, type BillCadence } from '$lib/server/db/schema';

export type ScheduleFields = { cadence: BillCadence; dueDay: number | null; dueDay2: number | null; interval: number | null; anchorDate: string | null };

/** Validate the cadence fields of a bill or income body. `partial` allows omitting cadence (patch); when cadence is present its companions are checked. */
export function scheduleFields(b: Record<string, unknown>, partial: boolean): Partial<ScheduleFields> {
	const out: Partial<ScheduleFields> = {};
	if (b.cadence === undefined) {
		if (!partial) throw new ValidationError('cadence is required');
		return out;
	}
	if (!(BILL_CADENCES as readonly string[]).includes(String(b.cadence))) throw new ValidationError('cadence is invalid');
	const cadence = b.cadence as BillCadence;
	const day = (k: string) => {
		const v = cents(b[k], k);
		if (v < 1 || v > 31) throw new ValidationError(`${k} must be 1-31`);
		return v;
	};
	out.cadence = cadence; out.dueDay = null; out.dueDay2 = null; out.interval = null; out.anchorDate = null;
	if (cadence === 'monthly') out.dueDay = day('dueDay');
	if (cadence === 'semi_monthly') { out.dueDay = day('dueDay'); out.dueDay2 = day('dueDay2'); }
	if (cadence === 'every_n_weeks') {
		out.interval = cents(b.interval, 'interval');
		if (out.interval < 1) throw new ValidationError('interval must be >= 1');
		out.anchorDate = isoDate(b.anchorDate, 'anchorDate');
	}
	if (cadence === 'yearly') out.anchorDate = isoDate(b.anchorDate, 'anchorDate');
	return out;
}

export function commonFields(b: Record<string, unknown>, partial: boolean) {
	const out: Record<string, unknown> = {};
	if (b.name !== undefined || !partial) {
		if (typeof b.name !== 'string' || !b.name.trim()) throw new ValidationError('name is required');
		out.name = b.name.trim();
	}
	if (b.categoryId !== undefined || !partial) out.categoryId = cents(b.categoryId, 'categoryId');
	if (b.expectedAmount !== undefined || !partial) out.expectedAmount = cents(b.expectedAmount, 'expectedAmount');
	if (b.toleranceAbs !== undefined) out.toleranceAbs = cents(b.toleranceAbs, 'toleranceAbs');
	if (b.tolerancePct !== undefined) out.tolerancePct = cents(b.tolerancePct, 'tolerancePct');
	if (b.matchPattern !== undefined) out.matchPattern = b.matchPattern === null ? null : String(b.matchPattern);
	return out;
}

/** Re-run occurrence generation from the app's config and settings. Called after any bill/income create or edit. */
export function regenerate() {
	const db = getDb();
	const c = getConfig();
	return generateOccurrences(db, { todayIso: todayIso(c.timeZone), cadence: c.cadence, graceDays: getSetting(db, 'grace_days', 3) });
}
