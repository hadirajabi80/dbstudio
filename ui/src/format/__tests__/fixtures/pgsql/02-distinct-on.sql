select distinct on (customer_id) customer_id, order_date, total from orders order by customer_id, order_date desc;
