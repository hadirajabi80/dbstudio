select id, row_number() over (partition by customer_id order by order_date desc) rn, sum(total) over (partition by customer_id) tot from orders;
