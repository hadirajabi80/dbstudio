select c.name, o.total from customers c, lateral (select * from orders o where o.customer_id = c.id order by o.order_date desc limit 3) o;
select c.name, x.n from customers c cross join lateral generate_series(1, 3) as x(n) left join lateral (select 1 as one) y on true;
