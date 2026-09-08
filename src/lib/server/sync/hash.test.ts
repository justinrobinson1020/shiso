import { describe, it, expect } from 'vitest';
import { contentHash } from './hash';

describe('contentHash', () => {
	it('is stable, ordinal-sensitive, and short', () => {
		const a = contentHash({ accountKey: 'acc', date: '2026-01-02', amount: -1234, description: 'COFFEE', ordinal: 0 });
		const b = contentHash({ accountKey: 'acc', date: '2026-01-02', amount: -1234, description: 'COFFEE', ordinal: 1 });
		expect(a).toBe(contentHash({ accountKey: 'acc', date: '2026-01-02', amount: -1234, description: 'COFFEE', ordinal: 0 }));
		expect(a).not.toBe(b);
		expect(a).toMatch(/^h1:[0-9a-f]{16}$/);
		expect(contentHash({ accountKey: 'acc', date: '2026-01-02', amount: -1234, description: '  coffee ', ordinal: 0 })).toBe(a);
	});
});
