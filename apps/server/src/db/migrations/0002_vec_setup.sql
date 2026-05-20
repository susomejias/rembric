-- sqlite-vec virtual table for vector candidate detection (consolidation only;
-- not on the agent retrieval hot path).
--
-- The dimension is fixed at table creation time. We default to 768 to match
-- common embedding models (nomic-embed-text, mxbai-embed-large baseline).
-- If you change LLM_EMBED_MODEL to a model with a different dimension, you
-- must drop and recreate this table; the application surfaces a warning on
-- startup when the configured dimension does not match the stored one.

CREATE VIRTUAL TABLE `memory_vec` USING vec0(
    memory_id TEXT PRIMARY KEY,
    embedding FLOAT[768]
);
