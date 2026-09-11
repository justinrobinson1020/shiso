import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ImportError } from './types';
vi.mock('../pdf', () => ({ pdfToText: vi.fn(async () => readFileSync(new URL('./fixtures/chase-dec-jan.txt', import.meta.url), 'utf8')) }));
import { parseText, detectAndParse } from './detect';
import { pdfToText } from '../pdf';
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
describe('parseText', () => {
	it('routes each format by content', () => {
		expect(parseText('Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By\n').format).toBe('apple');
		expect(parseText('Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n').format).toBe('capital_one');
		expect(parseText('"Transaction ID","Posting Date","Effective Date","Transaction Type","Posting Status","Amount","Check Number","Reference Number","Description","Transaction Category","Type","Balance","Memo","Extended Description"\n').format).toBe('nasa_fcu');
		expect(parseText(fx('chase-dec-jan.txt')).format).toBe('chase');
		expect(parseText(fx('synchrony-paypal.txt')).format).toBe('synchrony');
	});
	it('rejects unknown content with an ImportError', () => {
		expect(() => parseText('hello\nworld')).toThrow(ImportError);
		try { parseText('hello'); } catch (e) { expect((e as ImportError).code).toBe('unknown_format'); }
	});
});
describe('detectAndParse', () => {
	it('sends %PDF bytes through pdftotext and everything else through the text decoder', async () => {
		const pdf = await detectAndParse(new TextEncoder().encode('%PDF-1.4 fake'));
		expect(pdf.format).toBe('chase'); expect(pdfToText).toHaveBeenCalledTimes(1);
		const csv = await detectAndParse(new TextEncoder().encode('Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n'));
		expect(csv.format).toBe('capital_one'); expect(pdfToText).toHaveBeenCalledTimes(1);
	});
});
