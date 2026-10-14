create index ix_orders_customer on orders (customer_id, created_at desc);
create sequence orders_seq start with 1 increment by 1 nocache;
