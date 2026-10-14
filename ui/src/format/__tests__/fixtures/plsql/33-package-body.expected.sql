CREATE OR REPLACE PACKAGE BODY order_api AS
    g_calls PLS_INTEGER := 0;
    PROCEDURE log_call (p_name VARCHAR2) IS
    BEGIN
        g_calls := g_calls + 1;
        dbms_output.put_line(p_name);
    END log_call;
    FUNCTION create_order (p_customer_id IN NUMBER, p_total IN NUMBER) RETURN NUMBER IS
        v_id NUMBER;
    BEGIN
        log_call('create_order');
        IF p_total > c_max THEN
            RAISE e_invalid;
        END IF;
        INSERT INTO orders (customer_id, total)
        VALUES (p_customer_id, p_total)
        RETURNING id INTO v_id;
        RETURN v_id;
    END create_order;
    PROCEDURE cancel_order (p_id IN NUMBER, p_reason IN VARCHAR2 DEFAULT NULL) IS
    BEGIN
        UPDATE orders
        SET
            status = 'C',
            note = p_reason
        WHERE id = p_id;
    END cancel_order;
    FUNCTION list_orders (p_customer_id NUMBER) RETURN t_orders PIPELINED IS
    BEGIN
        FOR r IN (
            SELECT
                id,
                total,
                note
            FROM orders
            WHERE customer_id = p_customer_id
        ) LOOP
            pipe ROW (t_order(r.id, r.total, r.note));
        END LOOP;
        RETURN;
    END list_orders;
BEGIN
    g_calls := 0;
END order_api;
/
