DECLARE
    CURSOR c_orders(p_min NUMBER) IS
        SELECT
            id,
            total
        FROM orders
        WHERE total >= p_min;
    TYPE t_orders IS TABLE OF c_orders%ROWTYPE INDEX BY PLS_INTEGER;
    l_orders t_orders;
BEGIN
    OPEN c_orders(100);
    LOOP
        FETCH c_orders BULK COLLECT INTO l_orders LIMIT 500;
        EXIT WHEN l_orders.count = 0;
        FORALL i IN 1..l_orders.count
            INSERT INTO archive (id, total)
            VALUES (l_orders(i).id, l_orders(i).total);
    END LOOP;
    CLOSE c_orders;
END;
/
