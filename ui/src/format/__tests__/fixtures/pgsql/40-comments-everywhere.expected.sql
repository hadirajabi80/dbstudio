-- leading comment
SELECT
    id, -- the key
    name /* inline */,
    total
FROM orders -- source
WHERE total > 0; -- trailing
