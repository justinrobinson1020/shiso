export class InvariantError extends Error {
	constructor(public readonly code: string, message?: string) {
		super(message ?? code);
		this.name = 'InvariantError';
	}
}

/** A row the caller named does not exist. `handle()` maps it to a 404. */
export class NotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NotFoundError';
	}
}
