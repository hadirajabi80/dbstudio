CREATE OR REPLACE TRIGGER trg_orders_biu
BEFORE INSERT OR UPDATE OF total ON orders
FOR EACH ROW
WHEN (new.total > 0)
DECLARE
    v_now DATE := SYSDATE;
BEGIN
    IF inserting THEN
        :new.created_at := v_now;
    END IF;
    :new.updated_at := v_now;
END;
/
