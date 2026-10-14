SELECT
    c.name,
    o.total
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.total > 100
ORDER BY o.total DESC;
