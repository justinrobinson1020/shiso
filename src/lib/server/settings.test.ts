import { describe, it, expect } from 'vitest';
import { openMemoryDatabase } from './test/memory-db';
import { getSetting, setSetting } from './settings';

describe('settings', () => {
	it('round-trips JSON values with a fallback', () => {
		const { db } = openMemoryDatabase();
		expect(getSetting(db, 'grace_days', 3)).toBe(3);
		setSetting(db, 'grace_days', 5);
		expect(getSetting(db, 'grace_days', 3)).toBe(5);
		setSetting(db, 'provider_category_map', { a: 1 });
		expect(getSetting(db, 'provider_category_map', {})).toEqual({ a: 1 });
	});
});
