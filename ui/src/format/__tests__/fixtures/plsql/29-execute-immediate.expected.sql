BEGIN
    EXECUTE IMMEDIATE 'truncate table tmp_orders';
    EXECUTE IMMEDIATE 'select count(*) from orders where total > :1' INTO v_cnt USING p_min;
END;
/
