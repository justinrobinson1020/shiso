import { json, type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import { InvariantError, NotFoundError } from './ledger/errors';

export class ValidationError extends Error {
	constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

/** Wrap a route: return a value → 200 json; throw ValidationError → 400; InvariantError → 409; NotFoundError → 404; else rethrow. */
export function handle(fn: (event: RequestEvent) => unknown | Promise<unknown>): RequestHandler {
	return async (event) => {
		try {
			return json(await fn(event));
		} catch (err) {
			if (err instanceof ValidationError) return json({ error: err.message }, { status: 400 });
			if (err instanceof InvariantError) return json({ error: err.message, code: err.code }, { status: 409 });
			if (err instanceof NotFoundError) return json({ error: err.message }, { status: 404 });
			throw err;
		}
	};
}

export async function readJson<T>(request: Request): Promise<T> {
	try { return (await request.json()) as T; }
	catch { throw new ValidationError('body must be JSON'); }
}

/** Like `readJson`, but an absent or non-JSON body is `{}`: for routes whose body only carries optional switches. */
export async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
	const body: unknown = await request.json().catch(() => ({}));
	return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function intParam(v: string | undefined | null, name: string): number {
	if (v == null || !/^\d+$/.test(v)) throw new ValidationError(`${name} must be an integer`);
	return Number(v);
}

/** An integer from a JSON body field (ids, days, counts). */
export function int(v: unknown, name: string): number {
	if (typeof v !== 'number' || !Number.isInteger(v)) throw new ValidationError(`${name} must be an integer`);
	return v;
}

/** A non-empty string from a JSON body field, trimmed. */
export function str(v: unknown, name: string): string {
	if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${name} is required`);
	return v.trim();
}

/** Integer cents from a JSON body field. */
export function cents(v: unknown, name: string): number {
	if (typeof v !== 'number' || !Number.isInteger(v)) throw new ValidationError(`${name} must be integer cents`);
	return v;
}

/** ISO calendar date from a JSON body field. */
export function isoDate(v: unknown, name: string): string {
	if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ValidationError(`${name} must be YYYY-MM-DD`);
	return v;
}
