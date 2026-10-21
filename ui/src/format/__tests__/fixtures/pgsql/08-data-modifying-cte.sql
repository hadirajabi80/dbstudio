with moved as (delete from orders where order_date < now() - interval '1 year' returning *) insert into orders_archive select * from moved;
