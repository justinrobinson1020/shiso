#!/usr/bin/env tsx
// One-time import of the pay-period Google Sheet (spec §11). Usage:
//   npx tsx scripts/import-sheet.ts --db ./data/shiso.db --xlsx ~/Downloads/budget.xlsx --year 2025 --mapping ./mapping.json [--checking 3] [--dry-run]
// mapping.json: { "Sapphire": 4, "Freedom": 5, ... }  (sheet name → shiso account id; see /accounts)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import * as XLSX from 'xlsx';
import { openDatabase } from '../src/lib/server/db';
import { importSheet, parseTab, periodEndForTab, type Grid } from '../src/lib/server/import/sheet';

const { values } = parseArgs({ options: { db: { type: 'string' }, xlsx: { type: 'string' }, year: { type: 'string' }, mapping: { type: 'string' }, checking: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
if (!values.db || !values.xlsx || !values.year || !values.mapping) { console.error('required: --db --xlsx --year --mapping'); process.exit(2); }
const wb = XLSX.readFile(values.xlsx);
const tabs = wb.SheetNames.map((name) => ({ name, grid: XLSX.utils.sheet_to_json<Grid[number]>(wb.Sheets[name], { header: 1, raw: false, defval: null }) as Grid }));
const year = Number(values.year); const mapping = JSON.parse(readFileSync(values.mapping, 'utf8')) as Record<string, number>;
if (values['dry-run']) {
	for (const t of tabs) { const d = periodEndForTab(t.name, year); if (!d) { console.log(`ignore  ${t.name}`); continue; } const p = parseTab(t.grid); console.log(`${d}  ${t.name}: checking=${p.checking} debts=${p.debts.map((x) => `${x.name}:${x.balance}@${x.aprBps}`).join(' ')}`); }
	process.exit(0);
}
const { db, sqlite } = openDatabase({ path: values.db, backupDir: join(dirname(values.db), 'backups'), migrationsFolder: 'drizzle' });
const report = db.transaction((tx) => importSheet(tx, tabs, { year, mapping, checkingAccountId: values.checking ? Number(values.checking) : null }));
sqlite.close();
console.log(JSON.stringify(report, null, 2));
