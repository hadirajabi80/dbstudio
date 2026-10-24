-- rebuildRequired: false, transactional: false
-- warning: ClickHouse has no UNIQUE constraints (ReplacingMergeTree deduplicates by the sorting key); they are not scripted.

-- [alter]
ALTER TABLE shop.orders DROP CONSTRAINT ck_orders_total;

-- [alter] A new CHECK constraint is enforced for inserted rows only; existing rows are not checked.
ALTER TABLE shop.orders ADD CONSTRAINT ck_orders_total CHECK total >= 0 AND total < 1000000;
