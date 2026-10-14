SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) rn,
    SUM(total) OVER (PARTITION BY customer_id) tot
FROM orders;
