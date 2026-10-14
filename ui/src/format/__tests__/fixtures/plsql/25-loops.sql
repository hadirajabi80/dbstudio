begin
for i in 1 .. 10 loop dbms_output.put_line(i); end loop;
for r in (select id, name from customers where active = 'Y') loop process(r.id); end loop;
while v_i < 10 loop v_i := v_i + 1; exit when v_i = 5; continue when mod(v_i, 2) = 0; end loop;
loop fetch c into v_rec; exit when c%notfound; end loop;
end;
/
