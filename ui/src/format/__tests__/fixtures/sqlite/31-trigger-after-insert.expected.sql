CREATE TRIGGER trg_orders_ins
AFTER INSERT ON orders
FOR EACH ROW
WHEN new.total > 1000
BEGIN
    INSERT INTO audit (msg)
    VALUES ('big ' || new.id);
    UPDATE customers
    SET last_order = new.id
    WHERE id = new.customer_id;
END;
