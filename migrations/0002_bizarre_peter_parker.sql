PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_transaction_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` text,
	`user_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`transaction_type` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_transaction_history`("id", "transaction_id", "user_id", "amount", "transaction_type", "created_at") SELECT "id", "transaction_id", "user_id", "amount", "transaction_type", "created_at" FROM `transaction_history`;--> statement-breakpoint
DROP TABLE `transaction_history`;--> statement-breakpoint
ALTER TABLE `__new_transaction_history` RENAME TO `transaction_history`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `transaction_id_idx` ON `transaction_history` (`transaction_id`);