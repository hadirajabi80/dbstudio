SELECT
    c.name,
    o.total
FROM customers c, LATERAL (
    SELECT *
    FROM orders o
    WHERE o.customer_id = c.id
    ORDER BY o.order_date DESC
    LIMIT 3
) o;

SELECT
    c.name,
    x.n
FROM customers c
CROSS JOIN LATERAL GENERATE_SERIES(1, 3) AS x(n)
LEFT JOIN LATERAL (
    SELECT 1 AS one
) y ON TRUE;
