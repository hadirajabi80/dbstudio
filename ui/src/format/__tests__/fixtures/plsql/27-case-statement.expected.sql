BEGIN
    CASE v_status
        WHEN 'N' THEN
            v_text := 'new';
        WHEN 'P' THEN
            v_text := 'paid';
            v_flag := true;
        ELSE
            v_text := 'other';
    END CASE;
    CASE
        WHEN v_total > 100 THEN
            big();
        ELSE
            small();
    END CASE;
END;
/
