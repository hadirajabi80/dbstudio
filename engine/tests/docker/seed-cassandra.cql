-- Cassandra "shop" keyspace (plan-batch3 WP-CS), run by the one-shot cassandra-seed service (cqlsh -f) and by the
-- Cassandra test fixture (statement by statement). Idempotent: drops and recreates the keyspace.
--
-- The same logical data as the other shop fixtures (docs/PLAN.md 4.14: 3 countries, 5 customers, 6 orders with order 1
-- totalling 120.50, 4 products, 7 order lines), modelled the Cassandra way: one table per query, denormalised.
--   countries            id → country (reference data)
--   customers            id → customer, with a UDT address, set/list/map collections and an SAI index on email
--   products             id → product (map of attributes)
--   orders               id → order (customer name copied in, frozen<address> shipping address)
--   orders_by_customer   query table: orders of a customer, newest first (clustering order DESC)
--   orders_by_status     materialized view over orders (needs materialized_views_enabled: true)
--   order_lines          one partition per order, a row per product
--   product_views        counter table
--   events_by_day        composite partition key (customer_id, day), timeuuid clustering, default TTL 90 days
--   line_total(int, decimal) user-defined function (needs user_defined_functions_enabled: true)
-- Persian (RTL) text lives in customer notes, product attributes and order notes.
--
-- cassandra:5 ships with materialized views and UDFs disabled: without them the two statements that need them fail
-- and cqlsh carries on with the rest (the test fixture enables both in cassandra.yaml before the node starts).

DROP KEYSPACE IF EXISTS shop;

CREATE KEYSPACE shop
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
  AND durable_writes = true;

CREATE TYPE shop.address (
  street text,
  city text,
  postal_code text,
  country text
);

CREATE TABLE shop.countries (
  id int PRIMARY KEY,
  code text,
  name text,
  local_name text
) WITH comment = 'Countries (reference data)';

CREATE TABLE shop.customers (
  id int PRIMARY KEY,
  name text,
  email text,
  country_id int,
  country text,
  address frozen<address>,
  tags set<text>,
  phones list<text>,
  preferences map<text, text>,
  created_at timestamp,
  ext_id uuid,
  note text
) WITH comment = 'Customers by id';

CREATE INDEX customers_email_idx ON shop.customers (email) USING 'sai';

CREATE TABLE shop.products (
  id int PRIMARY KEY,
  sku text,
  name text,
  category text,
  price decimal,
  stock int,
  discontinued boolean,
  attributes map<text, text>
) WITH comment = 'Product catalogue';

CREATE TABLE shop.orders (
  id int PRIMARY KEY,
  customer_id int,
  customer_name text,
  order_date timestamp,
  status text,
  total decimal,
  shipping_address frozen<address>,
  note text
) WITH comment = 'Orders by id';

CREATE TABLE shop.orders_by_customer (
  customer_id int,
  order_date timestamp,
  order_id int,
  status text,
  total decimal,
  PRIMARY KEY ((customer_id), order_date, order_id)
) WITH CLUSTERING ORDER BY (order_date DESC, order_id ASC)
  AND comment = 'Query table: the orders of a customer, newest first';

CREATE TABLE shop.order_lines (
  order_id int,
  product_id int,
  product_name text,
  qty int,
  unit_price decimal,
  PRIMARY KEY ((order_id), product_id)
) WITH comment = 'The lines of an order (one partition per order)';

CREATE TABLE shop.product_views (
  product_id int PRIMARY KEY,
  views counter
) WITH comment = 'Counter table: product page views';

CREATE TABLE shop.events_by_day (
  customer_id int,
  day date,
  event_time timeuuid,
  kind text,
  payload text,
  PRIMARY KEY ((customer_id, day), event_time)
) WITH CLUSTERING ORDER BY (event_time DESC)
  AND default_time_to_live = 7776000
  AND comment = 'Customer activity per day (composite partition key, 90-day TTL)';

CREATE MATERIALIZED VIEW shop.orders_by_status AS
  SELECT id, status, customer_id, order_date, total
  FROM shop.orders
  WHERE status IS NOT NULL AND id IS NOT NULL
  PRIMARY KEY ((status), id)
  WITH comment = 'Orders by status (materialized view)';

CREATE FUNCTION shop.line_total(qty int, unit_price decimal)
  RETURNS NULL ON NULL INPUT
  RETURNS decimal
  LANGUAGE java
  AS $$ return unit_price.multiply(java.math.BigDecimal.valueOf(qty)); $$;

INSERT INTO shop.countries (id, code, name, local_name) VALUES (1, 'DE', 'Germany', 'Deutschland');
INSERT INTO shop.countries (id, code, name, local_name) VALUES (2, 'FR', 'France', 'France');
INSERT INTO shop.countries (id, code, name, local_name) VALUES (3, 'JP', 'Japan', '日本');

INSERT INTO shop.customers (id, name, email, country_id, country, address, tags, phones, preferences, created_at, ext_id, note)
  VALUES (1, 'Alice', 'alice@example.com', 1, 'Germany',
    {street: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE'},
    {'vip', 'newsletter'}, ['+49 30 1234567'], {'language': 'de', 'channel': 'email'},
    '2025-11-02T08:00:00Z', 6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11, 'Prefers e-mail');
INSERT INTO shop.customers (id, name, email, country_id, country, address, tags, phones, preferences, created_at, ext_id, note)
  VALUES (2, 'Bob', null, 2, 'France',
    {street: '12 rue de Rivoli', city: 'Paris', postal_code: '75001', country: 'FR'},
    {'newsletter'}, ['+33 1 23 45 67 89', '+33 6 12 34 56 78'], {'language': 'fr'},
    '2025-12-14T15:30:00Z', 0b7e4c2a-1f3d-4e5a-8c6b-9d0e1f2a3b22, 'مشتری ویژه — تماس فقط در ساعات اداری');
INSERT INTO shop.customers (id, name, email, country_id, country, address, tags, phones, preferences, created_at, ext_id, note)
  VALUES (3, 'Chie', 'chie@example.jp', 3, 'Japan',
    {street: '1-1 Chiyoda', city: 'Tokyo', postal_code: '100-0001', country: 'JP'},
    {}, [], {'language': 'ja'},
    '2026-01-20T01:15:00Z', 9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c33, null);
INSERT INTO shop.customers (id, name, email, country_id, country, address, tags, phones, preferences, created_at, ext_id, note)
  VALUES (4, 'Dora', 'dora@example.com', 1, 'Germany',
    {street: 'Marienplatz 8', city: 'Munich', postal_code: '80331', country: 'DE'},
    {'vip'}, ['+49 89 7654321'], {'language': 'de', 'channel': 'sms'},
    '2026-02-03T10:45:00Z', 3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e44, 'سفارش‌ها را هدیه بسته‌بندی کنید');
INSERT INTO shop.customers (id, name, email, country_id, country, created_at, ext_id)
  VALUES (5, 'Emil', null, null, null, '2026-02-28T19:00:00Z', 7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a55);

INSERT INTO shop.products (id, sku, name, category, price, stock, discontinued, attributes)
  VALUES (1, 'PER-0001', 'Keyboard', 'Peripherals', 49.90, 120, false, {'color': 'black', 'layout': 'ISO', 'name_fa': 'صفحه‌کلید'});
INSERT INTO shop.products (id, sku, name, category, price, stock, discontinued, attributes)
  VALUES (2, 'PER-0002', 'Mouse', 'Peripherals', 19.50, 300, false, {'color': 'white', 'name_fa': 'ماوس'});
INSERT INTO shop.products (id, sku, name, category, price, stock, discontinued, attributes)
  VALUES (3, 'MON-0003', 'Monitor', 'Monitors', 199.00, 25, false, {'size': '27"', 'name_fa': 'نمایشگر'});
INSERT INTO shop.products (id, sku, name, category, price, stock, discontinued, attributes)
  VALUES (4, 'CAB-0004', 'Cable', 'Cables', 5.25, 1000, true, {'length': '2m', 'name_fa': 'کابل'});

INSERT INTO shop.orders (id, customer_id, customer_name, order_date, status, total, shipping_address, note)
  VALUES (1, 1, 'Alice', '2026-01-05T10:00:00Z', 'delivered', 120.50,
    {street: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE'}, null);
INSERT INTO shop.orders (id, customer_id, customer_name, order_date, status, total, shipping_address, note)
  VALUES (2, 1, 'Alice', '2026-02-11T09:30:00Z', 'delivered', 19.50,
    {street: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE'}, 'Leave at the front desk');
INSERT INTO shop.orders (id, customer_id, customer_name, order_date, status, total, shipping_address, note)
  VALUES (3, 2, 'Bob', '2026-02-12T14:00:00Z', 'shipped', 199.00,
    {street: '12 rue de Rivoli', city: 'Paris', postal_code: '75001', country: 'FR'}, 'لطفاً قبل از ارسال تماس بگیرید');
INSERT INTO shop.orders (id, customer_id, customer_name, order_date, status, total, shipping_address, note)
  VALUES (4, 3, 'Chie', '2026-03-01T08:15:00Z', 'paid', 54.15,
    {street: '1-1 Chiyoda', city: 'Tokyo', postal_code: '100-0001', country: 'JP'}, 'Gift wrap, please');
INSERT INTO shop.orders (id, customer_id, customer_name, order_date, status, total, shipping_address, note)
  VALUES (5, 4, 'Dora', '2026-03-02T17:45:00Z', 'new', 5.25,
    {street: 'Marienplatz 8', city: 'Munich', postal_code: '80331', country: 'DE'}, 'سفارش فوری');
INSERT INTO shop.orders (id, customer_id, customer_name, order_date, status, total, shipping_address, note)
  VALUES (6, 4, 'Dora', '2026-03-03T12:00:00Z', 'cancelled', 249.00,
    {street: 'Marienplatz 8', city: 'Munich', postal_code: '80331', country: 'DE'}, null);

INSERT INTO shop.orders_by_customer (customer_id, order_date, order_id, status, total) VALUES (1, '2026-01-05T10:00:00Z', 1, 'delivered', 120.50);
INSERT INTO shop.orders_by_customer (customer_id, order_date, order_id, status, total) VALUES (1, '2026-02-11T09:30:00Z', 2, 'delivered', 19.50);
INSERT INTO shop.orders_by_customer (customer_id, order_date, order_id, status, total) VALUES (2, '2026-02-12T14:00:00Z', 3, 'shipped', 199.00);
INSERT INTO shop.orders_by_customer (customer_id, order_date, order_id, status, total) VALUES (3, '2026-03-01T08:15:00Z', 4, 'paid', 54.15);
INSERT INTO shop.orders_by_customer (customer_id, order_date, order_id, status, total) VALUES (4, '2026-03-02T17:45:00Z', 5, 'new', 5.25);
INSERT INTO shop.orders_by_customer (customer_id, order_date, order_id, status, total) VALUES (4, '2026-03-03T12:00:00Z', 6, 'cancelled', 249.00);

INSERT INTO shop.order_lines (order_id, product_id, product_name, qty, unit_price) VALUES (1, 1, 'Keyboard', 2, 49.90);
INSERT INTO shop.order_lines (order_id, product_id, product_name, qty, unit_price) VALUES (1, 2, 'Mouse', 1, 19.50);
INSERT INTO shop.order_lines (order_id, product_id, product_name, qty, unit_price) VALUES (2, 2, 'Mouse', 1, 19.50);
INSERT INTO shop.order_lines (order_id, product_id, product_name, qty, unit_price) VALUES (3, 3, 'Monitor', 1, 199.00);
INSERT INTO shop.order_lines (order_id, product_id, product_name, qty, unit_price) VALUES (4, 1, 'Keyboard', 1, 49.90);
INSERT INTO shop.order_lines (order_id, product_id, product_name, qty, unit_price) VALUES (4, 4, 'Cable', 1, 4.25);
INSERT INTO shop.order_lines (order_id, product_id, product_name, qty, unit_price) VALUES (6, 3, 'Monitor', 1, 199.00);

UPDATE shop.product_views SET views = views + 42 WHERE product_id = 1;
UPDATE shop.product_views SET views = views + 17 WHERE product_id = 2;
UPDATE shop.product_views SET views = views + 99 WHERE product_id = 3;
UPDATE shop.product_views SET views = views + 3 WHERE product_id = 4;

BEGIN BATCH
  INSERT INTO shop.events_by_day (customer_id, day, event_time, kind, payload) VALUES (1, '2026-03-01', 50554d6e-2bb1-11f1-8000-000000000001, 'login', '{"ip": "10.0.0.1"}');
  INSERT INTO shop.events_by_day (customer_id, day, event_time, kind, payload) VALUES (1, '2026-03-01', 6b9a7c00-2bb4-11f1-8000-000000000001, 'view', '{"product": 3}');
  INSERT INTO shop.events_by_day (customer_id, day, event_time, kind, payload) VALUES (1, '2026-03-01', 8e3b1200-2bb8-11f1-8000-000000000001, 'order', '{"order": 4}');
APPLY BATCH;
INSERT INTO shop.events_by_day (customer_id, day, event_time, kind, payload) VALUES (4, '2026-03-02', a1b2c300-2c6c-11f1-8000-000000000004, 'login', '{"ip": "10.0.0.4"}');
INSERT INTO shop.events_by_day (customer_id, day, event_time, kind, payload) VALUES (4, '2026-03-02', b2c3d400-2c7a-11f1-8000-000000000004, 'cart', '{"note": "سبد خرید"}');
