CREATE OR REPLACE PACKAGE order_api AUTHID DEFINER AS
    c_max CONSTANT NUMBER := 1000;
    e_invalid EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_invalid, -20001);
    TYPE t_order IS RECORD (
        id NUMBER,
        total NUMBER(12, 2),
        note VARCHAR2(200)
    );
    TYPE t_orders IS TABLE OF t_order;
    FUNCTION create_order (p_customer_id IN NUMBER, p_total IN NUMBER) RETURN NUMBER;
    PROCEDURE cancel_order (p_id IN NUMBER, p_reason IN VARCHAR2 DEFAULT NULL);
    FUNCTION list_orders (p_customer_id NUMBER) RETURN t_orders PIPELINED;
END order_api;
/
