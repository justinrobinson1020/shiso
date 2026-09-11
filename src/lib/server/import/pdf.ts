import { execFile } from 'node:child_process';
import { ImportError } from './formats/types';
/** The only place shiso spawns a process. poppler-utils must be installed on the host (docs/deploy.md §2). */
export function pdfToText(bytes: Uint8Array): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile('pdftotext', ['-layout', '-', '-'], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
			if (err) reject(new ImportError('pdf', (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'pdftotext is not installed' : `pdftotext failed: ${err.message}`));
			else resolve(stdout);
		});
		child.stdin!.on('error', () => { /* pdftotext exited early; the callback carries the error */ });
		child.stdin!.end(Buffer.from(bytes));
	});
}
