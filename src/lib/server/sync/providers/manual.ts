import { emptyBatch, type FetchInput, type SyncBatch, type SyncProvider } from '../types';

/** Manual accounts never fetch; balances and CSV imports are entered through the app. */
export class ManualProvider implements SyncProvider {
	readonly kind = 'manual' as const;
	async fetch(input: FetchInput): Promise<SyncBatch> {
		return emptyBatch(input.cursor);
	}
}
