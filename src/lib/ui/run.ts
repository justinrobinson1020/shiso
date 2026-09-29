import { invalidateAll } from '$app/navigation';
import { errorMessage } from './api';

/** Run a page action, then reload the page data. Resolves with the failure message, or '' on success. */
export async function attempt(fn: () => Promise<unknown>): Promise<string> {
	try { await fn(); await invalidateAll(); return ''; }
	catch (e) { return errorMessage(e); }
}
