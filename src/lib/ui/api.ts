export class ApiError extends Error {
	constructor(public readonly status: number, message: string, public readonly code?: string) { super(message); this.name = 'ApiError'; }
}
/** The message of a caught value, whatever was thrown. */
export function errorMessage(e: unknown): string { return e instanceof Error ? e.message : String(e); }

async function parse<T>(res: Response): Promise<T> {
	const data: unknown = await res.json().catch(() => ({}));
	if (!res.ok) {
		const body = typeof data === 'object' && data !== null ? (data as { error?: unknown; code?: unknown }) : {};
		throw new ApiError(res.status, typeof body.error === 'string' ? body.error : res.statusText, typeof body.code === 'string' ? body.code : undefined);
	}
	return data as T;
}
/** POST JSON to an API route; resolve with the parsed body or throw ApiError with the server's message. */
export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
	return parse<T>(await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}
/** Multipart upload (CSV import). */
export async function upload<T = unknown>(path: string, form: FormData): Promise<T> {
	return parse<T>(await fetch(path, { method: 'POST', body: form }));
}
