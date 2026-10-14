update orders set total = total * 1.1, note = 'raised' where customer_id in (select id from customers where vip = 1) returning id;
