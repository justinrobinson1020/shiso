import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pdfToText } from './pdf';
const have = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.skipIf(!have)('pdfToText', () => {
	it('extracts layout text from a PDF given on stdin', async () => {
		const text = await pdfToText(readFileSync(new URL('./formats/fixtures/tiny.pdf', import.meta.url)));
		expect(text).toContain('Hello statement 12/05 UBER 95.26');
	});
});
