ALTER TABLE orders ADD COLUMN note2 TEXT;
ALTER TABLE orders RENAME COLUMN note2 TO remark;
ALTER TABLE orders RENAME TO orders_old;
ALTER TABLE orders_old DROP COLUMN remark;
