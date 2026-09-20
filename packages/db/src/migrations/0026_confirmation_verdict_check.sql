-- 0026_confirmation_verdict_check.sql
--
-- Make the `verdict` domain unrepresentable rather than service-enforced.
--
-- 0024 added the column with a DEFAULT but no CHECK, so `'affirmed'`,
-- `'AFFIRM'` or `''` were all storable and every read path that filters
-- `verdict = 'affirm'` would silently stop counting the row — which is the
-- shape of the JS/SQL divergence fixed in ab7a5f6, made impossible here.
--
-- SQLite cannot add a CHECK to an existing column, so this is the standard
-- table-rebuild dance. `confirmations` is a FK CHILD only (of `memory` and
-- `sessions`) and no table references it, so nothing dangles; the migration
-- runner still wraps the body in `foreign_keys = OFF` … `foreign_key_check`
-- … COMMIT, so no pragma belongs here.
--
-- The INSERT normalizes any value outside the domain to 'affirm' instead of
-- letting the CHECK abort the migration. On every database this code wrote
-- that CASE is the identity function — the column only ever received the two
-- literals and its default is 'affirm' — and the alternative is a server that
-- refuses to boot with no operator path forward. 'affirm' is the value 0024
-- already backfilled every historical row with.
--
-- A rebuild DROPs the table and with it EVERY index on it, so all four are
-- recreated below (0000 created two, 0003 one, 0025 one). `schema-drift.test.ts`
-- asserts the index set as an exact set, which is the guard that none was lost.

CREATE TABLE confirmations_new (
  id text PRIMARY KEY NOT NULL,
  memory_id text NOT NULL REFERENCES memory(id),
  event_ts integer NOT NULL,
  source text,
  session_id text REFERENCES sessions(id),
  verdict text NOT NULL DEFAULT 'affirm' CONSTRAINT confirmations_verdict_check CHECK (verdict IN ('affirm', 'refute')),
  reason text
);
--> statement-breakpoint

INSERT INTO confirmations_new (id, memory_id, event_ts, source, session_id, verdict, reason)
SELECT
  id,
  memory_id,
  event_ts,
  source,
  session_id,
  CASE WHEN verdict IN ('affirm', 'refute') THEN verdict ELSE 'affirm' END,
  reason
FROM confirmations;
--> statement-breakpoint

DROP TABLE confirmations;
--> statement-breakpoint

ALTER TABLE confirmations_new RENAME TO confirmations;
--> statement-breakpoint

CREATE INDEX confirmations_memory_id_idx ON confirmations (memory_id);
--> statement-breakpoint
CREATE INDEX confirmations_event_ts_idx ON confirmations (event_ts);
--> statement-breakpoint
CREATE INDEX confirmations_session_idx ON confirmations (session_id);
--> statement-breakpoint
CREATE INDEX confirmations_memory_verdict_ts_idx ON confirmations (memory_id, verdict, event_ts);
