INSERT OR REPLACE INTO kv (k, v)
VALUES ('a', 1);

REPLACE INTO kv (k, v)
VALUES ('b', 2);

INSERT OR IGNORE INTO kv (k, v)
SELECT
    k,
    v
FROM staging;
