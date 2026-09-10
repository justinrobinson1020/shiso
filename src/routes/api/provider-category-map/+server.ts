import { handle, readJson, ValidationError } from '$lib/server/http';
import { getDb } from '$lib/server/db/instance';
import { categories } from '$lib/server/db/schema';
import { applyProviderCategoryMap, getProviderCategoryMap, providerCategoryUsage, setProviderCategoryMap } from '$lib/server/sync/postprocess';

export const GET = handle(async () => {
	const db = getDb();
	return { map: getProviderCategoryMap(db), providerCategories: providerCategoryUsage(db) };
});

export const POST = handle(async ({ request }) => {
	const b = await readJson<{ map?: Record<string, unknown>; applyToExisting?: boolean }>(request);
	if (b.map == null || typeof b.map !== 'object' || Array.isArray(b.map)) throw new ValidationError('map is required');
	const db = getDb();
	const validIds = new Set(db.select({ id: categories.id }).from(categories).all().map((c) => c.id));
	const map: Record<string, number> = {};
	for (const [key, value] of Object.entries(b.map)) {
		if (typeof value !== 'number' || !Number.isInteger(value) || !validIds.has(value)) {
			throw new ValidationError(`${key} must map to an existing category id`);
		}
		map[key] = value;
	}
	setProviderCategoryMap(db, map);
	const categorized = b.applyToExisting ? applyProviderCategoryMap(db).categorized : 0;
	return { ok: true, categorized };
});
