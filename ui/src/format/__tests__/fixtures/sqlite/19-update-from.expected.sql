UPDATE inventory
SET qty = qty - s.qty
FROM (
    SELECT
        item_id,
        SUM(qty) qty
    FROM sales
    GROUP BY item_id
) s
WHERE s.item_id = inventory.item_id;
