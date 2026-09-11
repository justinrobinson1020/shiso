import { handle, intParam } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { closePromo } from '$lib/server/debt/plan';
export const POST = handle(async ({ params }) => { closePromo(getDb(), intParam(params.id, 'id')); return { ok: true }; });
