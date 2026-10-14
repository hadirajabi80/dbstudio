BEGIN
    <<outer_loop>>
    FOR i IN 1..3 LOOP
        <<inner_loop>>
        FOR j IN 1..3 LOOP
            EXIT outer_loop WHEN i * j > 4;
        END LOOP inner_loop;
    END LOOP outer_loop;
END;
/
