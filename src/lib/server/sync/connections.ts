import { and, desc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import {
	accounts, accountBalances, accountTerms, connections,
	CASH_TYPES, type AccountType, type ConnectionStatus, type Provider
} from '../db/schema';
import { encryptSecret, decryptSecret } from './crypto';
import { nowIso } from '$lib/dates';

const touch = () => ({ updatedAt: nowIso() });

export function createConnection(db: DbOrTx, input: {
	provider: Provider; institutionName: string; externalItemId?: string | null; credential?: string | null; appKey: string;
}): number {
	return db.insert(connections).values({
		provider: input.provider,
		institutionName: input.institutionName,
		externalItemId: input.externalItemId ?? null,
		credentialEnc: input.credential ? encryptSecret(input.appKey, input.credential) : null
	}).returning({ id: connections.id }).get().id;
}

export function setCredential(db: DbOrTx, connectionId: number, credential: string, appKey: string): void {
	db.update(connections).set({ credentialEnc: encryptSecret(appKey, credential), ...touch() }).where(eq(connections.id, connectionId)).run();
}

export function getCredential(db: DbOrTx, connectionId: number, appKey: string): string | null {
	const row = db.select({ enc: connections.credentialEnc }).from(connections).where(eq(connections.id, connectionId)).get();
	if (!row) throw new Error(`connection ${connectionId} not found`);
	return row.enc ? decryptSecret(appKey, row.enc) : null;
}

export function setConnectionStatus(db: DbOrTx, connectionId: number, status: ConnectionStatus, error?: string | null): void {
	db.update(connections).set({ status, lastError: error ?? null, ...touch() }).where(eq(connections.id, connectionId)).run();
}

export function recordConnectionSuccess(db: DbOrTx, connectionId: number, cursor: string | null, at: string): void {
	db.update(connections)
		.set({ cursor, lastSuccessAt: at, status: 'active', lastError: null, ...touch() })
		.where(eq(connections.id, connectionId))
		.run();
}

export function getConnection(db: DbOrTx, connectionId: number) {
	const row = db.select().from(connections).where(eq(connections.id, connectionId)).get();
	if (!row) throw new Error(`connection ${connectionId} not found`);
	return row;
}

export function listActiveConnections(db: DbOrTx) {
	return db
		.select({ id: connections.id, provider: connections.provider, institutionName: connections.institutionName, cursor: connections.cursor })
		.from(connections)
		.where(eq(connections.status, 'active'))
		.all();
}

export function upsertAccount(db: DbOrTx, connectionId: number, a: {
	externalId: string; name: string; officialName?: string | null; mask?: string | null; type: AccountType;
}): { id: number; created: boolean } {
	const existing = db
		.select({ id: accounts.id })
		.from(accounts)
		.where(and(eq(accounts.connectionId, connectionId), eq(accounts.externalId, a.externalId)))
		.get();
	if (existing) {
		db.update(accounts)
			.set({ name: a.name, officialName: a.officialName ?? null, mask: a.mask ?? null, ...touch() })
			.where(eq(accounts.id, existing.id))
			.run();
		return { id: existing.id, created: false };
	}
	const id = db.insert(accounts).values({
		connectionId,
		externalId: a.externalId,
		name: a.name,
		officialName: a.officialName ?? null,
		mask: a.mask ?? null,
		type: a.type,
		onBudget: (CASH_TYPES as readonly string[]).includes(a.type) || a.type === 'credit',
		isDebt: a.type === 'credit' || a.type === 'loan'
	}).returning({ id: accounts.id }).get().id;
	return { id, created: true };
}

export function accountsForConnection(db: DbOrTx, connectionId: number) {
	return db.select().from(accounts).where(eq(accounts.connectionId, connectionId)).all();
}

export function appendBalance(db: DbOrTx, accountId: number, b: {
	asOf: string; current: number; available?: number | null; creditLimit?: number | null; source: 'sync' | 'manual' | 'import';
}): number {
	return db.insert(accountBalances).values({
		accountId, asOf: b.asOf, current: b.current, available: b.available ?? null, creditLimit: b.creditLimit ?? null, source: b.source
	}).returning({ id: accountBalances.id }).get().id;
}

export function latestBalance(db: DbOrTx, accountId: number) {
	return db.select().from(accountBalances).where(eq(accountBalances.accountId, accountId))
		.orderBy(desc(accountBalances.asOf), desc(accountBalances.id)).get() ?? null;
}

export function latestTerms(db: DbOrTx, accountId: number) {
	return db.select().from(accountTerms).where(eq(accountTerms.accountId, accountId))
		.orderBy(desc(accountTerms.asOf), desc(accountTerms.id)).get() ?? null;
}

export type TermsInput = {
	asOf: string; aprBps?: number | null; promoAprBps?: number | null; minPayment?: number | null; nextDueDate?: string | null;
	lastStatementBalance?: number | null; lastStatementDate?: string | null; annualFee?: number | null; source: 'provider' | 'manual';
};

const TERM_FIELDS = ['aprBps', 'promoAprBps', 'minPayment', 'nextDueDate', 'lastStatementBalance', 'lastStatementDate', 'annualFee'] as const;

/** §4.1: append-only, insert on change. Manual edits always insert. */
export function appendTermsIfChanged(db: DbOrTx, accountId: number, t: TermsInput): boolean {
	const prev = latestTerms(db, accountId);
	if (t.source === 'provider' && prev) {
		const same = TERM_FIELDS.every((f) => (t[f] ?? null) === (prev[f] ?? null));
		if (same) return false;
	}
	db.insert(accountTerms).values({
		accountId, asOf: t.asOf, source: t.source,
		aprBps: t.aprBps ?? null, promoAprBps: t.promoAprBps ?? null, minPayment: t.minPayment ?? null,
		nextDueDate: t.nextDueDate ?? null, lastStatementBalance: t.lastStatementBalance ?? null,
		lastStatementDate: t.lastStatementDate ?? null, annualFee: t.annualFee ?? null
	}).run();
	return true;
}
