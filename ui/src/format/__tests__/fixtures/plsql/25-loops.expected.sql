BEGIN
    FOR i IN 1..10 LOOP
        dbms_output.put_line(i);
    END LOOP;
    FOR r IN (
        SELECT
            id,
            name
        FROM customers
        WHERE active = 'Y'
    ) LOOP
        process(r.id);
    END LOOP;
    WHILE v_i < 10 LOOP
        v_i := v_i + 1;
        EXIT WHEN v_i = 5;
        CONTINUE WHEN MOD(v_i, 2) = 0;
    END LOOP;
    LOOP
        FETCH c INTO v_rec;
        EXIT WHEN c%NOTFOUND;
    END LOOP;
END;
/
