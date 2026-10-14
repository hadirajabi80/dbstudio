CREATE OR REPLACE VIEW v_big_orders AS
SELECT
    o.id,
    o.total
FROM orders o
WHERE o.total > 1000 WITH READ ONLY;
