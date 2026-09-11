import { handle, intParam } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { clearTarget } from '$lib/server/budget/targets';
export const POST = handle(async ({ params }) => { clearTarget(getDb(), intParam(params.categoryId, 'categoryId')); return { ok: true }; });
