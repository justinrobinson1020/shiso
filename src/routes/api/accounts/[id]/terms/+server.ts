import { handle, readJson, intParam, cents, isoDate } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { appendTermsIfChanged } from '$lib/server/sync/connections';

export const POST = handle(async ({ request, params }) => {
	const b = await readJson<Record<string, unknown>>(request);
	const opt = (k: string) => (b[k] == null ? null : cents(b[k], k));
	const optDate = (k: string) => (b[k] == null ? null : isoDate(b[k], k));
	appendTermsIfChanged(getDb(), intParam(params.id, 'id'), {
		asOf: isoDate(b.asOf, 'asOf'),
		source: 'manual',
		aprBps: opt('aprBps'),
		promoAprBps: opt('promoAprBps'),
		minPayment: opt('minPayment'),
		nextDueDate: optDate('nextDueDate'),
		lastStatementBalance: opt('lastStatementBalance'),
		lastStatementDate: optDate('lastStatementDate'),
		annualFee: opt('annualFee')
	});
	return { inserted: true };
});
