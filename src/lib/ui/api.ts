export class ApiError extends Error {
	constructor(public readonly status: number, message: string, public readonly code?: string) { super(message); this.name = 'ApiError'; }
}
/** POST JSON to an API route; resolve with the parsed body or throw ApiError with the server's message. */
export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
	const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.code);
	return data as T;
}
/** Multipart upload (CSV import). */
export async function upload<T = unknown>(path: string, form: FormData): Promise<T> {
	const res = await fetch(path, { method: 'POST', body: form });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.code);
	return data as T;
}
