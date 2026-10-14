select c.name, o.total from customers c join orders o on o.customer_id = c.id where o.total > 100 order by o.total desc;
