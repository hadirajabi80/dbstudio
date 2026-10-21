copy orders (id, customer_id, total) from '/tmp/orders.csv' with (format csv, header true);
copy (select * from customers) to stdout with (format csv);
