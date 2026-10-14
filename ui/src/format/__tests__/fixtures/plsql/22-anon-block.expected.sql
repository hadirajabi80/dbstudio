DECLARE
    v_count NUMBER := 0;
    v_name customers.name%TYPE;
BEGIN
    SELECT COUNT(*)
    INTO v_count
    FROM orders;
    dbms_output.put_line('count: ' || v_count);
END;
/
