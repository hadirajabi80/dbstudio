set search_path to public, sales;
show search_path;
reset all;
listen orders_changed;
notify orders_changed, 'payload';
lock table orders in share mode;
