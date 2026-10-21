SELECT
    id,
    total,
    SUM(total) OVER (PARTITION BY customer_id ORDER BY order_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running,
    RANK() OVER w
FROM orders
WINDOW w AS (PARTITION BY customer_id ORDER BY total DESC);
