import { addDays } from '$lib/dates';

/** The subset of `Range` (see `$lib/server/read/spending`) that stepping needs. */
export type SteppableRange = { kind: string; start: string; end: string; prevStart: string; prevEnd: string };

export type StepParams = { anchor: string; end: string | null };

/** Step to the previous range. `resolveRange` already computed the correct previous bounds. */
export function stepBack(range: SteppableRange): StepParams {
	return { anchor: range.prevStart, end: range.kind === 'custom' ? range.prevEnd : null };
}

/** Step to the next range: the anchor moves to the day after `end`. */
export function stepForward(range: SteppableRange): StepParams {
	const len = (Date.parse(range.end) - Date.parse(range.start)) / 86400000;
	return { anchor: addDays(range.end, 1), end: range.kind === 'custom' ? addDays(range.end, 1 + len) : null };
}
