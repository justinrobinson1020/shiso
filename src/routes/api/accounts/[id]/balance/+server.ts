import { handle, readJson, intParam, cents, isoDate } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { appendBalance } from '$lib/server/sync/connections';

export const POST = handle(async ({ request, params }) => {
	const b = await readJson<{ current: unknown; asOf: unknown; available?: unknown; creditLimit?: unknown }>(request);
	return {
		id: appendBalance(getDb(), intParam(params.id, 'id'), {
			current: cents(b.current, 'current'),
			asOf: isoDate(b.asOf, 'asOf'),
			available: b.available == null ? null : cents(b.available, 'available'),
			creditLimit: b.creditLimit == null ? null : cents(b.creditLimit, 'creditLimit'),
			source: 'manual'
		})
	};
});
