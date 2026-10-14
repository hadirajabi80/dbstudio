SELECT
    COUNT(*) FILTER (WHERE total > 100) AS big,
    COUNT(*) AS total
FROM orders;
