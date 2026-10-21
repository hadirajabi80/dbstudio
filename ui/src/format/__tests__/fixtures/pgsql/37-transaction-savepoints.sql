begin;
update orders set status = 'paid' where id = 1;
savepoint before_delete;
delete from order_lines where order_id = 1;
rollback to savepoint before_delete;
release savepoint before_delete;
commit;
start transaction isolation level serializable;
end;
