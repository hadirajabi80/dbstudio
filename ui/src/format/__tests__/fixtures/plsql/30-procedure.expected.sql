CREATE OR REPLACE PROCEDURE archive_orders (p_before IN DATE, p_count OUT NUMBER) AS
    PRAGMA AUTONOMOUS_TRANSACTION;
BEGIN
    INSERT INTO archive
    SELECT *
    FROM orders
    WHERE order_date < p_before;
    p_count := SQL%ROWCOUNT;
    DELETE FROM orders
    WHERE order_date < p_before;
    COMMIT;
EXCEPTION
    WHEN OTHERS THEN
        ROLLBACK;
        RAISE_APPLICATION_ERROR(-20010, 'archive failed: ' || SQLERRM);
END archive_orders;
/
