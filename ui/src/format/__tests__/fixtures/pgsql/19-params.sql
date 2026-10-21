select * from orders where customer_id = $1 and status = $2::order_status and total > :min_total and note like @pattern;
