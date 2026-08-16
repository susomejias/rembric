-- 0035_drop_session_summary_versions.sql
--
-- Destroys every stored version row irreversibly (`persistence`, "The
-- `session_summary_versions` table MUST be dropped by a dedicated migration,
-- with `0033` retained on disk").

DROP TABLE session_summary_versions;
