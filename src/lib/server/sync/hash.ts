import { createHash } from 'node:crypto';

/** Deterministic id for rows whose provider gives none. Description is normalised (trim, collapse spaces, lower-case). */
export function contentHash(p: { accountKey: string; date: string; amount: number; description: string; ordinal: number }): string {
	const desc = p.description.trim().replace(/\s+/g, ' ').toLowerCase();
	const h = createHash('sha256').update(`${p.accountKey}|${p.date}|${p.amount}|${desc}|${p.ordinal}`).digest('hex');
	return `h1:${h.slice(0, 16)}`;
}
