CREATE OR REPLACE TRIGGER trg_orders_cmp
FOR UPDATE OF total ON orders
COMPOUND TRIGGER
    g_count PLS_INTEGER := 0;
    BEFORE STATEMENT IS
    BEGIN
        g_count := 0;
    END BEFORE STATEMENT;
    AFTER EACH ROW IS
    BEGIN
        g_count := g_count + 1;
    END AFTER EACH ROW;
    AFTER STATEMENT IS
    BEGIN
        dbms_output.put_line(g_count);
    END AFTER STATEMENT;
END trg_orders_cmp;
/
