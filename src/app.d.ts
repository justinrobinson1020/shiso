// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
	interface Window {
		Plaid?: {
			create(o: { token: string; onSuccess: (publicToken: string, meta: { institution?: { name?: string } }) => void; onExit?: () => void }): { open(): void };
		};
	}
}

export {};
