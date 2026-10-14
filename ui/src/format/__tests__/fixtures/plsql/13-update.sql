update orders o set o.total = o.total * 1.1, o.note = 'raised' where exists (select 1 from customers c where c.id = o.customer_id and c.vip = 'Y');
