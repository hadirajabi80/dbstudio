SELECT
    customer_id,
    COUNT(*) AS cnt,
    SUM(total) AS amount
FROM orders
GROUP BY customer_id
HAVING COUNT(*) > 5
ORDER BY amount DESC;
