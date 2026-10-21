CREATE OR REPLACE VIEW customer_orders AS
SELECT
    c.id AS customer_id,
    c.name,
    COUNT(o.id) AS order_count
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY
    c.id,
    c.name;

CREATE MATERIALIZED VIEW customer_totals AS
SELECT
    customer_id,
    SUM(total) AS total
FROM orders
GROUP BY customer_id WITH NO DATA;

REFRESH MATERIALIZED VIEW CONCURRENTLY customer_totals;
