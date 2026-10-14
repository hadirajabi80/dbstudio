SELECT *
FROM (
    SELECT
        id,
        total
    FROM orders
    ORDER BY total DESC
)
WHERE ROWNUM <= 10;
