import { sql } from 'drizzle-orm';
import {
	sqliteTable, integer, text, index, uniqueIndex, type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core';

// ---- string unions used as enums --------------------------------------
export const PROVIDERS = ['plaid', 'simplefin', 'manual'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const CONNECTION_STATUSES = ['active', 'needs_relink', 'error', 'disabled'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const ACCOUNT_TYPES = ['checking', 'savings', 'cash', 'credit', 'loan', 'investment'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
/** The only types whose balances count toward ready-to-assign (§4.1). */
export const CASH_TYPES = ['checking', 'savings', 'cash'] as const;

export const CATEGORY_KINDS = [
	'spending', 'bill', 'debt_payment', 'interest', 'fee',
	'income', 'transfer', 'savings', 'reconciliation'
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const TRANSACTION_SOURCES = ['sync', 'manual', 'import', 'opening', 'adjustment'] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const OCCURRENCE_STATUSES = ['pending', 'paid', 'overdue', 'skipped'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const BILL_CADENCES = ['monthly', 'semi_monthly', 'every_n_weeks', 'yearly'] as const;
export type BillCadence = (typeof BILL_CADENCES)[number];

const NOW = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const timestamps = {
	createdAt: text('created_at').notNull().default(NOW),
	updatedAt: text('updated_at').notNull().default(NOW)
};

// ---- 4.1 connections and accounts -------------------------------------
export const connections = sqliteTable('connections', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	provider: text('provider', { enum: PROVIDERS }).notNull(),
	institutionName: text('institution_name').notNull(),
	externalItemId: text('external_item_id'),
	credentialEnc: text('credential_enc'),
	status: text('status', { enum: CONNECTION_STATUSES }).notNull().default('active'),
	cursor: text('cursor'),
	lastSuccessAt: text('last_success_at'),
	lastError: text('last_error'),
	...timestamps
});

export const accounts = sqliteTable('accounts', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	connectionId: integer('connection_id').notNull().references(() => connections.id),
	externalId: text('external_id').notNull(),
	name: text('name').notNull(),
	officialName: text('official_name'),
	mask: text('mask'),
	type: text('type', { enum: ACCOUNT_TYPES }).notNull(),
	onBudget: integer('on_budget', { mode: 'boolean' }).notNull(),
	isDebt: integer('is_debt', { mode: 'boolean' }).notNull(),
	closedAt: text('closed_at'),
	...timestamps
}, (t) => [uniqueIndex('accounts_connection_external').on(t.connectionId, t.externalId)]);

export const accountBalances = sqliteTable('account_balances', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	accountId: integer('account_id').notNull().references(() => accounts.id),
	asOf: text('as_of').notNull(),
	current: integer('current').notNull(),
	available: integer('available'),
	creditLimit: integer('credit_limit'),
	source: text('source', { enum: ['sync', 'manual', 'import'] }).notNull(),
	createdAt: text('created_at').notNull().default(NOW)
}, (t) => [index('account_balances_account_asof').on(t.accountId, t.asOf)]);

export const accountTerms = sqliteTable('account_terms', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	accountId: integer('account_id').notNull().references(() => accounts.id),
	asOf: text('as_of').notNull(),
	aprBps: integer('apr_bps'),
	promoAprBps: integer('promo_apr_bps'),
	minPayment: integer('min_payment'),
	nextDueDate: text('next_due_date'),
	lastStatementBalance: integer('last_statement_balance'),
	lastStatementDate: text('last_statement_date'),
	annualFee: integer('annual_fee'),
	source: text('source', { enum: ['provider', 'manual'] }).notNull(),
	createdAt: text('created_at').notNull().default(NOW)
}, (t) => [index('account_terms_account_asof').on(t.accountId, t.asOf)]);

// ---- 4.3 budget (declared before ledger because transactions reference periods)
export const categoryGroups = sqliteTable('category_groups', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	sort: integer('sort').notNull().default(0),
	hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
	...timestamps
});

export const categories = sqliteTable('categories', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	groupId: integer('group_id').notNull().references(() => categoryGroups.id),
	name: text('name').notNull(),
	sort: integer('sort').notNull().default(0),
	hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
	kind: text('kind', { enum: CATEGORY_KINDS }).notNull(),
	accountId: integer('account_id').references(() => accounts.id),
	/** Seeded by the app, not the user; the lookups in categories.ts select on this. */
	isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
	...timestamps
}, (t) => [uniqueIndex('categories_debt_account').on(t.accountId).where(sql`kind = 'debt_payment'`)]);

export const periods = sqliteTable('periods', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	startDate: text('start_date').notNull(),
	endDate: text('end_date').notNull(),
	label: text('label').notNull()
}, (t) => [uniqueIndex('periods_start').on(t.startDate)]);

export const budgetAssignments = sqliteTable('budget_assignments', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	periodId: integer('period_id').notNull().references(() => periods.id),
	categoryId: integer('category_id').notNull().references(() => categories.id),
	assigned: integer('assigned').notNull().default(0),
	...timestamps
}, (t) => [uniqueIndex('budget_assignments_period_category').on(t.periodId, t.categoryId)]);

// ---- 4.2 ledger --------------------------------------------------------
export const transactions = sqliteTable('transactions', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	accountId: integer('account_id').notNull().references(() => accounts.id),
	externalId: text('external_id').notNull(),
	pendingExternalId: text('pending_external_id'),
	postedDate: text('posted_date').notNull(),
	transactedAt: text('transacted_at'),
	amount: integer('amount').notNull(),
	payeeRaw: text('payee_raw').notNull(),
	payee: text('payee').notNull(),
	memo: text('memo'),
	pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
	providerCategory: text('provider_category'),
	periodId: integer('period_id').notNull().references(() => periods.id),
	transferPeerId: integer('transfer_peer_id').references((): AnySQLiteColumn => transactions.id),
	deletedAt: text('deleted_at'),
	replacedById: integer('replaced_by_id').references((): AnySQLiteColumn => transactions.id),
	needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
	reviewReason: text('review_reason'),
	processedAt: text('processed_at'),
	source: text('source', { enum: TRANSACTION_SOURCES }).notNull(),
	...timestamps
}, (t) => [
	uniqueIndex('transactions_account_external').on(t.accountId, t.externalId),
	index('transactions_account_posted').on(t.accountId, t.postedDate),
	index('transactions_period').on(t.periodId),
	index('transactions_unprocessed').on(t.processedAt).where(sql`processed_at is null`)
]);

export const transactionSplits = sqliteTable('transaction_splits', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	transactionId: integer('transaction_id').notNull().references(() => transactions.id),
	categoryId: integer('category_id').notNull().references(() => categories.id),
	amount: integer('amount').notNull(),
	memo: text('memo')
}, (t) => [
	index('transaction_splits_transaction').on(t.transactionId),
	index('transaction_splits_category').on(t.categoryId)
]);

export const payeeRules = sqliteTable('payee_rules', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	pattern: text('pattern').notNull(),
	isRegex: integer('is_regex', { mode: 'boolean' }).notNull().default(false),
	payee: text('payee').notNull(),
	categoryId: integer('category_id').references(() => categories.id),
	priority: integer('priority').notNull().default(100),
	...timestamps
});

// ---- 4.4 bills and income ---------------------------------------------
export const bills = sqliteTable('bills', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	categoryId: integer('category_id').notNull().references(() => categories.id),
	payFromAccountId: integer('pay_from_account_id').notNull().references(() => accounts.id),
	expectedAmount: integer('expected_amount').notNull(),
	toleranceAbs: integer('tolerance_abs').notNull().default(0),
	tolerancePct: integer('tolerance_pct').notNull().default(0),
	cadence: text('cadence', { enum: BILL_CADENCES }).notNull(),
	dueDay: integer('due_day'),
	dueDay2: integer('due_day_2'),
	interval: integer('interval'),
	anchorDate: text('anchor_date'),
	autopay: integer('autopay', { mode: 'boolean' }).notNull().default(false),
	matchPattern: text('match_pattern'),
	linkedDebtAccountId: integer('linked_debt_account_id').references(() => accounts.id),
	active: integer('active', { mode: 'boolean' }).notNull().default(true),
	...timestamps
});

export const billOccurrences = sqliteTable('bill_occurrences', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	billId: integer('bill_id').notNull().references(() => bills.id),
	dueDate: text('due_date').notNull(),
	periodId: integer('period_id').notNull().references(() => periods.id),
	expectedAmount: integer('expected_amount').notNull(),
	statementBalance: integer('statement_balance'),
	status: text('status', { enum: OCCURRENCE_STATUSES }).notNull().default('pending'),
	paidAmount: integer('paid_amount').notNull().default(0),
	extraAmount: integer('extra_amount').notNull().default(0),
	markedBy: text('marked_by', { enum: ['auto', 'manual'] }),
	windowStart: text('window_start').notNull(),
	windowEnd: text('window_end').notNull(),
	needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
	...timestamps
}, (t) => [uniqueIndex('bill_occurrences_bill_due').on(t.billId, t.dueDate)]);

export const billOccurrenceTransactions = sqliteTable('bill_occurrence_transactions', {
	billOccurrenceId: integer('bill_occurrence_id').notNull().references(() => billOccurrences.id),
	transactionId: integer('transaction_id').notNull().references(() => transactions.id)
}, (t) => [uniqueIndex('bill_occurrence_transactions_pk').on(t.billOccurrenceId, t.transactionId)]);

export const incomeSources = sqliteTable('income_sources', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	categoryId: integer('category_id').notNull().references(() => categories.id),
	depositAccountId: integer('deposit_account_id').notNull().references(() => accounts.id),
	expectedAmount: integer('expected_amount').notNull(),
	toleranceAbs: integer('tolerance_abs').notNull().default(0),
	tolerancePct: integer('tolerance_pct').notNull().default(0),
	cadence: text('cadence', { enum: BILL_CADENCES }).notNull(),
	dueDay: integer('due_day'),
	dueDay2: integer('due_day_2'),
	interval: integer('interval'),
	anchorDate: text('anchor_date'),
	matchPattern: text('match_pattern'),
	active: integer('active', { mode: 'boolean' }).notNull().default(true),
	...timestamps
});

export const incomeOccurrences = sqliteTable('income_occurrences', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	incomeSourceId: integer('income_source_id').notNull().references(() => incomeSources.id),
	dueDate: text('due_date').notNull(),
	periodId: integer('period_id').notNull().references(() => periods.id),
	expectedAmount: integer('expected_amount').notNull(),
	status: text('status', { enum: OCCURRENCE_STATUSES }).notNull().default('pending'),
	receivedAmount: integer('received_amount').notNull().default(0),
	markedBy: text('marked_by', { enum: ['auto', 'manual'] }),
	transactionId: integer('transaction_id').references(() => transactions.id),
	windowStart: text('window_start').notNull(),
	windowEnd: text('window_end').notNull(),
	...timestamps
}, (t) => [uniqueIndex('income_occurrences_source_due').on(t.incomeSourceId, t.dueDate)]);

// ---- 4.5 operations ----------------------------------------------------
export const syncRuns = sqliteTable('sync_runs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	connectionId: integer('connection_id').notNull().references(() => connections.id),
	trigger: text('trigger', { enum: ['cron', 'manual', 'startup'] }).notNull(),
	startedAt: text('started_at').notNull(),
	finishedAt: text('finished_at'),
	status: text('status', { enum: ['running', 'ok', 'error'] }).notNull().default('running'),
	startCursor: text('start_cursor'),
	endCursor: text('end_cursor'),
	added: integer('added').notNull().default(0),
	modified: integer('modified').notNull().default(0),
	removed: integer('removed').notNull().default(0),
	balancesWritten: integer('balances_written').notNull().default(0),
	termsWritten: integer('terms_written').notNull().default(0),
	error: text('error')
}, (t) => [index('sync_runs_connection_started').on(t.connectionId, t.startedAt)]);

export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value', { mode: 'json' }).notNull(),
	updatedAt: text('updated_at').notNull().default(NOW)
});
