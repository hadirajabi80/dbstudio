begin execute immediate 'truncate table tmp_orders'; execute immediate 'select count(*) from orders where total > :1' into v_cnt using p_min; end;
/
