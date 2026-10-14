SELECT
    q.customer_id,
    q.n
FROM (
    SELECT
        customer_id,
        COUNT(*) n
    FROM orders
    GROUP BY customer_id
) q
WHERE q.n > 2;
