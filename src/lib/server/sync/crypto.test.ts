import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from './crypto';

const KEY = 'k'.repeat(44);
describe('secret encryption', () => {
	it('round-trips and never repeats ciphertext', () => {
		const a = encryptSecret(KEY, 'access-sandbox-123');
		const b = encryptSecret(KEY, 'access-sandbox-123');
		expect(a).not.toBe(b);
		expect(a.startsWith('v1.')).toBe(true);
		expect(decryptSecret(KEY, a)).toBe('access-sandbox-123');
	});
	it('rejects a wrong key and a tampered payload', () => {
		const enc = encryptSecret(KEY, 'secret');
		expect(() => decryptSecret('x'.repeat(44), enc)).toThrow();
		const parts = enc.split('.');
		parts[3] = parts[3].slice(0, -2) + 'AA';
		expect(() => decryptSecret(KEY, parts.join('.'))).toThrow();
	});
});
