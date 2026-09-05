export class InvariantError extends Error {
	constructor(public readonly code: string, message?: string) {
		super(message ?? code);
		this.name = 'InvariantError';
	}
}
