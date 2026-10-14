BEGIN
    UPDATE orders
    SET total = 0
    WHERE id = 1;
    IF SQL%ROWCOUNT = 0 THEN
        RAISE no_data_found;
    END IF;
EXCEPTION
    WHEN no_data_found THEN
        dbms_output.put_line('none');
    WHEN dup_val_on_index OR value_error THEN
        NULL;
    WHEN OTHERS THEN
        ROLLBACK;
        RAISE;
END;
/
