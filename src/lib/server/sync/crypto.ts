import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function keyBytes(appKey: string): Buffer {
	return createHash('sha256').update(appKey, 'utf8').digest();
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function encryptSecret(appKey: string, plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', keyBytes(appKey), iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(appKey: string, enc: string): string {
	const [v, ivB, tagB, ctB] = enc.split('.');
	if (v !== 'v1' || !ivB || !tagB || !ctB) throw new Error('bad ciphertext');
	try {
		const decipher = createDecipheriv('aes-256-gcm', keyBytes(appKey), Buffer.from(ivB, 'base64url'));
		decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
		return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
	} catch {
		throw new Error('bad ciphertext');
	}
}
