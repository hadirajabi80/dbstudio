BEGIN
    DECLARE
        v NUMBER := 1;
    BEGIN
        v := v + 1;
    EXCEPTION
        WHEN OTHERS THEN
            NULL;
    END;
    dbms_output.put_line(v);
END;
/
