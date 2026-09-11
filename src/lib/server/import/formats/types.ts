export type ImportFormat = 'apple' | 'capital_one' | 'nasa_fcu' | 'chase' | 'synchrony';
export type ParsedRow = { postedDate: string; transactedAt: string | null; amount: number; payeeRaw: string; memo: string | null; providerCategory: string | null; referenceId: string | null };
export type ParsedStatement = { opensOn: string; closesOn: string; previousBalance: number; newBalance: number };
export type ParsedBalance = { asOf: string; current: number };
export type ParsedFile = { format: ImportFormat; mask: string | null; statement: ParsedStatement | null; rows: ParsedRow[]; balances: ParsedBalance[] };
export type ImportErrorCode = 'unknown_format' | 'mask_mismatch' | 'reconcile' | 'pdf';
export class ImportError extends Error { constructor(public readonly code: ImportErrorCode, message: string) { super(message); this.name = 'ImportError'; } }
