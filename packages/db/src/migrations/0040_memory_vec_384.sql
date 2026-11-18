-- Vectors of another model are not comparable at any dimension, so none is carried over; the identity reset and drain refill the table.
DROP TABLE memory_vec;
--> statement-breakpoint
CREATE VIRTUAL TABLE `memory_vec` USING vec0(
    memory_id TEXT PRIMARY KEY,
    partition_key TEXT partition key,
    status TEXT,
    type TEXT,
    embedding FLOAT[384]
);
