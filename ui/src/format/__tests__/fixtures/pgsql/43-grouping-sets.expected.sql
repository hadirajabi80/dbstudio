SELECT
    customer_id,
    status,
    SUM(total)
FROM orders
GROUP BY GROUPING SETS ((customer_id), (status), ())
HAVING SUM(total) > 0;

SELECT
    a,
    b
FROM t
GROUP BY ROLLUP (a, b);
