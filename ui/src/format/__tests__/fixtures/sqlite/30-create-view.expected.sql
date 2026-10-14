CREATE VIEW IF NOT EXISTS v_big AS
SELECT
    id,
    total
FROM orders
WHERE total > 1000;
