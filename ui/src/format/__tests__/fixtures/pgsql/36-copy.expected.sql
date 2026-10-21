COPY orders (id, customer_id, total) FROM '/tmp/orders.csv' WITH (FORMAT CSV, HEADER TRUE);
COPY (
    SELECT *
    FROM customers
) TO STDOUT WITH (FORMAT CSV);
