import { json, type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import { InvariantError } from './ledger/errors';

export class ValidationError extends Error {
	constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

/** Wrap a route: return a value → 200 json; throw ValidationError → 400; InvariantError → 409; "not found" → 404; else rethrow. */
export function handle(fn: (event: RequestEvent) => unknown | Promise<unknown>): RequestHandler {
	return async (event) => {
		try {
			return json(await fn(event));
		} catch (err) {
			if (err instanceof ValidationError) return json({ error: err.message }, { status: 400 });
			if (err instanceof InvariantError) return json({ error: err.message, code: err.code }, { status: 409 });
			if (err instanceof Error && /not found/i.test(err.message)) return json({ error: err.message }, { status: 404 });
			throw err;
		}
	};
}

export async function readJson<T>(request: Request): Promise<T> {
	try { return (await request.json()) as T; }
	catch { throw new ValidationError('body must be JSON'); }
}

export function intParam(v: string | undefined | null, name: string): number {
	if (v == null || !/^\d+$/.test(v)) throw new ValidationError(`${name} must be an integer`);
	return Number(v);
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
