CREATE TABLE `drift_watch` (
	`account_id` integer PRIMARY KEY NOT NULL,
	`drift` integer NOT NULL,
	`full_syncs` integer NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
