update orders o set total = o.total * 1.1, status = 'paid' from customers c where c.id = o.customer_id and c.country_id = 3 returning o.id, o.total;
update t set (a, b) = (select x, y from u where u.id = t.id);
