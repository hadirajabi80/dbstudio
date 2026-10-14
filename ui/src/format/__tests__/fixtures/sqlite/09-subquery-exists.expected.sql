SELECT *
FROM customers c
WHERE EXISTS (
    SELECT 1
    FROM orders o
    WHERE o.customer_id = c.id
)
    AND c.id NOT IN (
        SELECT customer_id
        FROM blacklist
    );
