truncate table orders, order_lines restart identity cascade;
vacuum (verbose, analyze) orders;
analyze customers;
reindex table orders;
