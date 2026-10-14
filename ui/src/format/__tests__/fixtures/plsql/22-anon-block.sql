declare v_count number := 0; v_name customers.name%type; begin select count(*) into v_count from orders; dbms_output.put_line('count: ' || v_count); end;
/
