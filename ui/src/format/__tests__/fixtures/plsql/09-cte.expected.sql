WITH big AS (
    SELECT
        id,
        total
    FROM orders
    WHERE total > 100
), cust AS (
    SELECT *
    FROM customers
)
SELECT
    b.id,
    c.name
FROM big b
JOIN cust c ON c.id = b.id;
