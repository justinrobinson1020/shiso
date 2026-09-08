import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { categoryTree } from '$lib/server/read/categories';

export const load: PageServerLoad = () => ({ tree: categoryTree(getDb()) });
