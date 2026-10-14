CREATE OR REPLACE FUNCTION order_total (p_order_id IN orders.id%TYPE) RETURN NUMBER DETERMINISTIC IS
    v_total NUMBER;
BEGIN
    SELECT SUM(qty * price)
    INTO v_total
    FROM order_lines
    WHERE order_id = p_order_id;
    RETURN NVL(v_total, 0);
END order_total;
/
