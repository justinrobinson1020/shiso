import { parse } from 'csv-parse/sync';
import { ImportError, type ParsedFile } from './types';
import { APPLE_HEADER, parseAppleCardCsv } from './apple';
import { CAPITAL_ONE_HEADER, parseCapitalOneCsv } from './capital-one';
import { NASA_HEADER, parseNasaFcuCsv } from './nasa-fcu';
import { isChaseStatement, parseChaseStatement } from './chase';
import { isSynchronyStatement, parseSynchronyStatement } from './synchrony';
import { pdfToText } from '../pdf';
function headerHas(firstLine: string, required: readonly string[]): boolean {
	try { const cols = (parse(firstLine, { bom: true, trim: true }) as string[][])[0] ?? []; return required.every((c) => cols.includes(c)); } catch { return false; }
}
export function parseText(text: string): ParsedFile {
	const first = text.split(/\r?\n/, 1)[0] ?? '';
	if (headerHas(first, APPLE_HEADER)) return parseAppleCardCsv(text);
	if (headerHas(first, CAPITAL_ONE_HEADER)) return parseCapitalOneCsv(text);
	if (headerHas(first, NASA_HEADER)) return parseNasaFcuCsv(text);
	if (isChaseStatement(text)) return parseChaseStatement(text);
	if (isSynchronyStatement(text)) return parseSynchronyStatement(text);
	throw new ImportError('unknown_format', 'unknown format: expected an Apple Card, Capital One, or NASA FCU CSV, or a Chase or Synchrony statement');
}
export async function detectAndParse(bytes: Uint8Array): Promise<ParsedFile> {
	const isPdf = bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
	return parseText(isPdf ? await pdfToText(bytes) : new TextDecoder().decode(bytes));
}
