SELECT
    customer_id,
    COUNT(*) cnt,
    SUM(total) amount
FROM orders
GROUP BY customer_id
HAVING COUNT(*) > 5
ORDER BY amount DESC;
