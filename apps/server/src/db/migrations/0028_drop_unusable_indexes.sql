-- Indexes no query predicate can serve. Separate from 0027's additions so a
-- bisect can tell a removal from an addition. Evidence per index:
-- `openspec/specs/persistence/spec.md`.
--
-- `confirmations_session_idx` was a candidate and is KEPT: measured at 50k
-- sessions it is selected and halves the session-content EXISTS.

DROP INDEX `confirmations_event_ts_idx`;
--> statement-breakpoint

DROP INDEX `consolidation_ops_reverted_at_idx`;
--> statement-breakpoint

DROP INDEX `oauth_tokens_expires_at_idx`;
--> statement-breakpoint

DROP INDEX `tokens_revoked_at_idx`;
--> statement-breakpoint

DROP INDEX `dashboard_sessions_token_id_idx`;
