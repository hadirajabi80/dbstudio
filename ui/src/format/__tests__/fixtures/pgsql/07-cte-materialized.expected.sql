WITH big AS MATERIALIZED (
    SELECT *
    FROM orders
    WHERE total > 100
), small AS NOT MATERIALIZED (
    SELECT *
    FROM orders
    WHERE total <= 100
)
SELECT COUNT(*)
FROM big
UNION ALL
SELECT COUNT(*)
FROM small;
