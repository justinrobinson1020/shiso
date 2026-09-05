CREATE TABLE `account_balances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`as_of` text NOT NULL,
	`current` integer NOT NULL,
	`available` integer,
	`credit_limit` integer,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_balances_account_asof` ON `account_balances` (`account_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `account_terms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`as_of` text NOT NULL,
	`apr_bps` integer,
	`promo_apr_bps` integer,
	`min_payment` integer,
	`next_due_date` text,
	`last_statement_balance` integer,
	`last_statement_date` text,
	`annual_fee` integer,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_terms_account_asof` ON `account_terms` (`account_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`official_name` text,
	`mask` text,
	`type` text NOT NULL,
	`on_budget` integer NOT NULL,
	`is_debt` integer NOT NULL,
	`closed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_connection_external` ON `accounts` (`connection_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `bill_occurrence_transactions` (
	`bill_occurrence_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	FOREIGN KEY (`bill_occurrence_id`) REFERENCES `bill_occurrences`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bill_occurrence_transactions_pk` ON `bill_occurrence_transactions` (`bill_occurrence_id`,`transaction_id`);--> statement-breakpoint
CREATE TABLE `bill_occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bill_id` integer NOT NULL,
	`due_date` text NOT NULL,
	`period_id` integer NOT NULL,
	`expected_amount` integer NOT NULL,
	`statement_balance` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`paid_amount` integer DEFAULT 0 NOT NULL,
	`extra_amount` integer DEFAULT 0 NOT NULL,
	`marked_by` text,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`needs_review` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`period_id`) REFERENCES `periods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bill_occurrences_bill_due` ON `bill_occurrences` (`bill_id`,`due_date`);--> statement-breakpoint
CREATE TABLE `bills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category_id` integer NOT NULL,
	`pay_from_account_id` integer NOT NULL,
	`expected_amount` integer NOT NULL,
	`tolerance_abs` integer DEFAULT 0 NOT NULL,
	`tolerance_pct` integer DEFAULT 0 NOT NULL,
	`cadence` text NOT NULL,
	`due_day` integer,
	`due_day_2` integer,
	`interval` integer,
	`anchor_date` text,
	`autopay` integer DEFAULT false NOT NULL,
	`match_pattern` text,
	`linked_debt_account_id` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pay_from_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_debt_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `budget_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`period_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`assigned` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `periods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_assignments_period_category` ON `budget_assignments` (`period_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`kind` text NOT NULL,
	`account_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `category_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_debt_account` ON `categories` (`account_id`) WHERE kind = 'debt_payment';--> statement-breakpoint
CREATE TABLE `category_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`institution_name` text NOT NULL,
	`external_item_id` text,
	`credential_enc` text,
	`status` text DEFAULT 'active' NOT NULL,
	`cursor` text,
	`last_success_at` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `income_occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`income_source_id` integer NOT NULL,
	`due_date` text NOT NULL,
	`period_id` integer NOT NULL,
	`expected_amount` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`received_amount` integer DEFAULT 0 NOT NULL,
	`marked_by` text,
	`transaction_id` integer,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`income_source_id`) REFERENCES `income_sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`period_id`) REFERENCES `periods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `income_occurrences_source_due` ON `income_occurrences` (`income_source_id`,`due_date`);--> statement-breakpoint
CREATE TABLE `income_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category_id` integer NOT NULL,
	`deposit_account_id` integer NOT NULL,
	`expected_amount` integer NOT NULL,
	`tolerance_abs` integer DEFAULT 0 NOT NULL,
	`tolerance_pct` integer DEFAULT 0 NOT NULL,
	`cadence` text NOT NULL,
	`due_day` integer,
	`due_day_2` integer,
	`interval` integer,
	`anchor_date` text,
	`match_pattern` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deposit_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `payee_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL,
	`is_regex` integer DEFAULT false NOT NULL,
	`payee` text NOT NULL,
	`category_id` integer,
	`priority` integer DEFAULT 100 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `periods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`label` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `periods_start` ON `periods` (`start_date`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`trigger` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`start_cursor` text,
	`end_cursor` text,
	`added` integer DEFAULT 0 NOT NULL,
	`modified` integer DEFAULT 0 NOT NULL,
	`removed` integer DEFAULT 0 NOT NULL,
	`balances_written` integer DEFAULT 0 NOT NULL,
	`terms_written` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sync_runs_connection_started` ON `sync_runs` (`connection_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `transaction_splits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`memo` text,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transaction_splits_transaction` ON `transaction_splits` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `transaction_splits_category` ON `transaction_splits` (`category_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`pending_external_id` text,
	`posted_date` text NOT NULL,
	`transacted_at` text,
	`amount` integer NOT NULL,
	`payee_raw` text NOT NULL,
	`payee` text NOT NULL,
	`memo` text,
	`pending` integer DEFAULT false NOT NULL,
	`provider_category` text,
	`period_id` integer NOT NULL,
	`transfer_peer_id` integer,
	`deleted_at` text,
	`replaced_by_id` integer,
	`needs_review` integer DEFAULT false NOT NULL,
	`review_reason` text,
	`processed_at` text,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`period_id`) REFERENCES `periods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transfer_peer_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replaced_by_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_account_external` ON `transactions` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `transactions_account_posted` ON `transactions` (`account_id`,`posted_date`);--> statement-breakpoint
CREATE INDEX `transactions_period` ON `transactions` (`period_id`);--> statement-breakpoint
CREATE INDEX `transactions_unprocessed` ON `transactions` (`processed_at`) WHERE processed_at is null;