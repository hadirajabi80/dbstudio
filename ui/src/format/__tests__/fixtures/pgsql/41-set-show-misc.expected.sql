SET search_path TO public, sales;
SHOW search_path;
RESET ALL;
LISTEN orders_changed;
NOTIFY orders_changed, 'payload';
LOCK TABLE orders IN SHARE MODE;
