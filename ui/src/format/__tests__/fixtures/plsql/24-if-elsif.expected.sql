BEGIN
    IF a > 1 THEN
        x := 1;
    ELSIF a > 0 THEN
        x := 2;
    ELSIF a = 0 THEN
        NULL;
    ELSE
        x := 3;
    END IF;
END;
/
