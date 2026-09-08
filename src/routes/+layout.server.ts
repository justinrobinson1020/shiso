import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db/instance';
import { reviewCount } from '$lib/server/read/nav';

export const load: LayoutServerLoad = () => ({ nav: { reviewCount: reviewCount(getDb()) } });
