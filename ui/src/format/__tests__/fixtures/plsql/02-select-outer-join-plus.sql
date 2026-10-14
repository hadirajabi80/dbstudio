select o.id, c.name from orders o, customers c where o.customer_id = c.id(+) and c.country_id (+) = 10;
