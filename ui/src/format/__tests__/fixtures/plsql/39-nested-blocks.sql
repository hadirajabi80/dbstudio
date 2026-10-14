begin declare v number := 1; begin v := v + 1; exception when others then null; end; dbms_output.put_line(v); end;
/
