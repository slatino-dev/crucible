CREATE TABLE `aggregates` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_version_id` text NOT NULL,
	`target_id` text NOT NULL,
	`judge_config_hash` text,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`ci_low` real NOT NULL,
	`ci_high` real NOT NULL,
	`n` integer NOT NULL,
	`provenance_ref` text NOT NULL,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`suite_version_id`) REFERENCES `suite_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `aggregates_suite_target_idx` ON `aggregates` (`suite_version_id`,`target_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`label` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_uidx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`actor_key_hash` text NOT NULL,
	`action` text NOT NULL,
	`target_id` text NOT NULL,
	`before_hash` text,
	`after_hash` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE TABLE `baselines` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_version_id` text NOT NULL,
	`target_id` text NOT NULL,
	`aggregate_ref` text NOT NULL,
	`pinned_by` text NOT NULL,
	`pinned_at` text NOT NULL,
	FOREIGN KEY (`suite_version_id`) REFERENCES `suite_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`aggregate_ref`) REFERENCES `aggregates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `baselines_suite_target_uidx` ON `baselines` (`suite_version_id`,`target_id`);--> statement-breakpoint
CREATE TABLE `case_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`trial_idx` integer NOT NULL,
	`model_output_ref` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`tokens` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `case_results_run_idx` ON `case_results` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_results_run_case_trial_uidx` ON `case_results` (`run_id`,`case_id`,`trial_idx`);--> statement-breakpoint
CREATE TABLE `cases` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_version_id` text NOT NULL,
	`input` text NOT NULL,
	`expected` text,
	`scorer_type` text NOT NULL,
	`rubric_ref` text,
	`weight` real DEFAULT 1 NOT NULL,
	`tags` text NOT NULL,
	`param_template` text,
	`seed` integer,
	FOREIGN KEY (`suite_version_id`) REFERENCES `suite_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cases_suite_version_idx` ON `cases` (`suite_version_id`);--> statement-breakpoint
CREATE TABLE `comparisons` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`judge_config_hash` text NOT NULL,
	`case_result_candidate` text NOT NULL,
	`case_result_anchor` text NOT NULL,
	`verdict_order1` text NOT NULL,
	`verdict_order2` text NOT NULL,
	`verdict` text NOT NULL,
	`transcript_ref_order1` text NOT NULL,
	`transcript_ref_order2` text NOT NULL,
	`flags` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`case_result_candidate`) REFERENCES `case_results`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`case_result_anchor`) REFERENCES `case_results`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `comparisons_case_idx` ON `comparisons` (`case_id`);--> statement-breakpoint
CREATE TABLE `judges` (
	`id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`prompt_template` text NOT NULL,
	`prompt_version` text NOT NULL,
	`protocol` text NOT NULL,
	`k` integer NOT NULL,
	`aggregation` text NOT NULL,
	`calibration_ref` text,
	`config_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `judges_config_hash_uidx` ON `judges` (`config_hash`);--> statement-breakpoint
CREATE TABLE `regressions` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_version_id` text NOT NULL,
	`target_id` text NOT NULL,
	`baseline_ref` text NOT NULL,
	`run_id` text NOT NULL,
	`p_value` real NOT NULL,
	`q_value` real,
	`effect_size` real NOT NULL,
	`confirmation_run_id` text,
	`status` text NOT NULL,
	`detected_at` text NOT NULL,
	FOREIGN KEY (`suite_version_id`) REFERENCES `suite_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`baseline_ref`) REFERENCES `baselines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `regressions_suite_target_idx` ON `regressions` (`suite_version_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `regressions_detected_idx` ON `regressions` (`detected_at`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_version_hash` text NOT NULL,
	`target_id` text NOT NULL,
	`judge_config_hash` text,
	`anchor_run_id` text,
	`seed` integer NOT NULL,
	`sampling_params` text NOT NULL,
	`n_trials` integer NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`neurons_spent` integer DEFAULT 0 NOT NULL,
	`environment` text NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_suite_target_idx` ON `runs` (`suite_version_hash`,`target_id`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE TABLE `scores` (
	`id` text PRIMARY KEY NOT NULL,
	`case_result_id` text NOT NULL,
	`scorer` text NOT NULL,
	`verdict` text NOT NULL,
	`verdict_num` real,
	`judge_transcript_ref` text,
	`flags` text NOT NULL,
	FOREIGN KEY (`case_result_id`) REFERENCES `case_results`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scores_case_result_idx` ON `scores` (`case_result_id`);--> statement-breakpoint
CREATE TABLE `suite_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_id` text NOT NULL,
	`semver` text NOT NULL,
	`content_hash` text NOT NULL,
	`frozen_at` text NOT NULL,
	FOREIGN KEY (`suite_id`) REFERENCES `suites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `suite_versions_suite_idx` ON `suite_versions` (`suite_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `suite_versions_hash_uidx` ON `suite_versions` (`content_hash`);--> statement-breakpoint
CREATE TABLE `suites` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`domain` text NOT NULL,
	`cases_license` text NOT NULL,
	`cases_provenance` text NOT NULL,
	`judging` text NOT NULL,
	`anchor_target_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suites_slug_uidx` ON `suites` (`slug`);--> statement-breakpoint
CREATE TABLE `targets` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`params` text NOT NULL,
	`version_label` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `targets_fingerprint_idx` ON `targets` (`fingerprint`);