/** Robust location and scale for a list of amounts (P3 §3.2). */
export function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b); const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
export function mad(xs: number[], med = median(xs)): number {
	return median(xs.map((x) => Math.abs(x - med)));
}
/** `(x − median) / (1.4826 × MAD)`; with MAD 0 the scale is a tenth of the median so identical histories still flag a real jump. */
export function robustScore(x: number, history: number[]): { median: number; scale: number; score: number } {
	const med = median(history);
	const m = mad(history, med);
	const scale = m > 0 ? 1.4826 * m : 0.1 * med;
	const score = scale > 0 ? (x - med) / scale : x > med ? Infinity : 0;
	return { median: med, scale, score };
}
