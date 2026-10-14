create or replace view v_big_orders as select o.id, o.total from orders o where o.total > 1000 with read only;
