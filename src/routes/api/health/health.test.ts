import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET } from './+server';
import { resetForTests } from '$lib/server/startup';

beforeEach(() => { resetForTests(); });
afterEach(() => { resetForTests(); });

describe('GET /api/health', () => {
	it('reports degraded instead of throwing when the database is not initialised', async () => {
		const res = await (GET as unknown as () => Response | Promise<Response>)();
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.ok).toBe(false);
		expect(body.db).toBe('error');
		expect(typeof body.error).toBe('string');
	});
});
