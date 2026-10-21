create or replace view customer_orders as select c.id as customer_id, c.name, count(o.id) as order_count from customers c left join orders o on o.customer_id = c.id group by c.id, c.name;
create materialized view customer_totals as select customer_id, sum(total) as total from orders group by customer_id with no data;
refresh materialized view concurrently customer_totals;
