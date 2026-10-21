MERGE INTO stock s
USING deliveries d ON s.item_id = d.item_id
WHEN MATCHED AND d.qty = 0 THEN
    DELETE
WHEN MATCHED THEN
    UPDATE SET qty = s.qty + d.qty
WHEN NOT MATCHED THEN
    INSERT (item_id, qty)
    VALUES (d.item_id, d.qty);
