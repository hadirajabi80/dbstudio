create or replace procedure archive_orders(p_before in date, p_count out number) as
  pragma autonomous_transaction;
begin
  insert into archive select * from orders where order_date < p_before;
  p_count := sql%rowcount;
  delete from orders where order_date < p_before;
  commit;
exception
  when others then
    rollback;
    raise_application_error(-20010, 'archive failed: ' || sqlerrm);
end archive_orders;
/
