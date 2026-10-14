begin
  update orders set total = 0 where id = 1;
  if sql%rowcount = 0 then raise no_data_found; end if;
exception
  when no_data_found then dbms_output.put_line('none');
  when dup_val_on_index or value_error then null;
  when others then rollback; raise;
end;
/
