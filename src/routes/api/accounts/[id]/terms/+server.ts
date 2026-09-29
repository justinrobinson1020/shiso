import { handle, readJson, intParam, cents, int, isoDate } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { appendTermsIfChanged } from '$lib/server/sync/connections';

export const POST = handle(async ({ request, params }) => {
	const b = await readJson<Record<string, unknown>>(request);
	const money = (k: string) => (b[k] == null ? null : cents(b[k], k));
	const bps = (k: string) => (b[k] == null ? null : int(b[k], k));
	const optDate = (k: string) => (b[k] == null ? null : isoDate(b[k], k));
	appendTermsIfChanged(getDb(), intParam(params.id, 'id'), {
		asOf: isoDate(b.asOf, 'asOf'),
		source: 'manual',
		aprBps: bps('aprBps'),
		promoAprBps: bps('promoAprBps'),
		minPayment: money('minPayment'),
		nextDueDate: optDate('nextDueDate'),
		lastStatementBalance: money('lastStatementBalance'),
		lastStatementDate: optDate('lastStatementDate'),
		annualFee: money('annualFee')
	});
	return { inserted: true };
});
