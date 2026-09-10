import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { categoryTree, providerCategoryMapView } from '$lib/server/read/categories';

export const load: PageServerLoad = () => {
	const db = getDb();
	return { tree: categoryTree(db), pcm: providerCategoryMapView(db) };
};
