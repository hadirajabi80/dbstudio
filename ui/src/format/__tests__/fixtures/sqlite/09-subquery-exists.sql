select * from customers c where exists (select 1 from orders o where o.customer_id = c.id) and c.id not in (select customer_id from blacklist);
