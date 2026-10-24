-- Rowlit "shop" fixture for ClickHouse (plan-batch3 WP-CH; same logical model as seed-postgres.sql). Idempotent.
-- Runs once through docker-entrypoint-initdb.d (clickhouse-client --multiquery) and from the integration-test fixture
-- (statement by statement). Data: 3 countries, 5 customers, 6 orders (order 1 total 120.50), 4 products, 7 order lines,
-- plus ClickHouse extras: MergeTree tables with PARTITION BY / ORDER BY / TTL / skipping index / CHECK constraint,
-- LowCardinality / Nullable / Array / Map / Enum / DateTime64 columns, a view, a parametrised view, a materialized view
-- with its target table, a dictionary over products, a SQL user-defined function and reviews in Persian and Arabic.
CREATE DATABASE IF NOT EXISTS shop;

DROP DICTIONARY IF EXISTS shop.product_dict;
DROP VIEW IF EXISTS shop.daily_sales;
DROP VIEW IF EXISTS shop.customer_orders;
DROP VIEW IF EXISTS shop.orders_since;
DROP TABLE IF EXISTS shop.daily_sales_agg;
DROP TABLE IF EXISTS shop.reviews;
DROP TABLE IF EXISTS shop.order_lines;
DROP TABLE IF EXISTS shop.orders;
DROP TABLE IF EXISTS shop.products;
DROP TABLE IF EXISTS shop.customers;
DROP TABLE IF EXISTS shop.countries;

CREATE TABLE shop.countries
(
    id UInt32,
    name String
)
ENGINE = MergeTree
ORDER BY id
COMMENT 'Countries';

CREATE TABLE shop.customers
(
    id UInt32,
    name String COMMENT 'Display name',
    email Nullable(String),
    country_id Nullable(UInt32)
)
ENGINE = MergeTree
ORDER BY id
COMMENT 'Registered customers';

CREATE TABLE shop.orders
(
    id UInt32,
    customer_id UInt32,
    order_date DateTime('UTC'),
    total Decimal(12, 2),
    status LowCardinality(String) DEFAULT 'new',
    order_month UInt32 MATERIALIZED toYYYYMM(order_date),
    INDEX ix_orders_customer customer_id TYPE minmax GRANULARITY 1,
    CONSTRAINT ck_orders_total CHECK total >= 0
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(order_date)
ORDER BY (id)
TTL order_date + INTERVAL 30 YEAR
SETTINGS index_granularity = 8192
COMMENT 'Customer orders';

CREATE TABLE shop.products
(
    id UInt32,
    name String,
    price Nullable(Decimal(10, 2)),
    tags Array(String) DEFAULT [],
    attributes Map(String, String) DEFAULT map()
)
ENGINE = MergeTree
ORDER BY id;

CREATE TABLE shop.order_lines
(
    order_id UInt32,
    product_id UInt32,
    qty UInt32 DEFAULT 1,
    line_total Decimal(12, 2) DEFAULT 0
)
ENGINE = MergeTree
ORDER BY (order_id, product_id);

CREATE TABLE shop.reviews
(
    id UInt32,
    product_id UInt32,
    customer_id UInt32,
    lang Enum8('en' = 1, 'fa' = 2, 'ar' = 3),
    body String,
    rating UInt8,
    created DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(created)
ORDER BY (product_id, id)
COMMENT 'Product reviews (Persian, Arabic, English)';

CREATE TABLE shop.daily_sales_agg
(
    day Date,
    orders UInt64,
    revenue Decimal(38, 2)
)
ENGINE = SummingMergeTree
ORDER BY day;

INSERT INTO shop.countries VALUES (1, 'Germany'), (2, 'France'), (3, 'Japan');
INSERT INTO shop.customers VALUES
    (1, 'Alice', 'alice@example.com', 1), (2, 'Bob', NULL, 2), (3, 'Chie', 'chie@example.jp', 3),
    (4, 'Dora', 'dora@example.com', 1), (5, 'Emil', NULL, NULL);
INSERT INTO shop.products (id, name, price, tags, attributes) VALUES
    (1, 'Keyboard', 49.90, ['input', 'usb'], map('layout', 'ISO', 'color', 'black')),
    (2, 'Mouse', 19.50, ['input'], map('dpi', '1600')),
    (3, 'Monitor', 199.00, ['display'], map('size', '27"')),
    (4, 'Cable', 5.25, [], map());

CREATE MATERIALIZED VIEW shop.daily_sales TO shop.daily_sales_agg AS
SELECT toDate(order_date) AS day, count() AS orders, sum(toDecimal128(total, 2)) AS revenue
FROM shop.orders
GROUP BY day;

INSERT INTO shop.orders (id, customer_id, order_date, total) VALUES
    (1, 1, '2026-01-05 10:00:00', 120.50), (2, 1, '2026-02-11 09:30:00', 19.50), (3, 2, '2026-02-12 14:00:00', 199.00),
    (4, 3, '2026-03-01 08:15:00', 54.15), (5, 4, '2026-03-02 17:45:00', 5.25), (6, 4, '2026-03-03 12:00:00', 249.00);
INSERT INTO shop.order_lines (order_id, product_id, qty) VALUES (1, 1, 2), (1, 2, 1), (2, 2, 1), (3, 3, 1), (4, 1, 1), (4, 4, 1), (6, 3, 1);
INSERT INTO shop.reviews VALUES
    (1, 1, 1, 'en', 'Great keyboard, quiet keys.', 5, '2026-01-20 08:00:00.000'),
    (2, 1, 3, 'fa', 'صفحه‌کلید عالی است و کلیدها بی‌صدا هستند.', 5, '2026-02-02 11:30:00.000'),
    (3, 3, 2, 'ar', 'الشاشة واضحة جداً والألوان رائعة.', 4, '2026-02-20 19:45:00.000'),
    (4, 2, 4, 'fa', 'موس سبک و دقیقی است؛ قیمتش هم مناسب است.', 4, '2026-03-05 09:10:00.000'),
    (5, 4, 5, 'ar', 'كابل جيد لكنه قصير قليلاً.', 3, '2026-03-06 16:00:00.000');

CREATE VIEW shop.customer_orders AS
SELECT c.id AS customer_id, c.name, o.id AS order_id, o.total
FROM shop.customers AS c
INNER JOIN shop.orders AS o ON o.customer_id = c.id;

CREATE VIEW shop.orders_since AS
SELECT id, customer_id, order_date, total
FROM shop.orders
WHERE order_date >= {since:DateTime};

-- The local source reads as user shop (the docker images drop the default user when CLICKHOUSE_USER is set):
-- keep USER/PASSWORD in line with CLICKHOUSE_USER / CLICKHOUSE_PASSWORD of compose.yml and the test fixture.
CREATE DICTIONARY shop.product_dict
(
    id UInt64,
    name String,
    price Decimal(10, 2) DEFAULT 0
)
PRIMARY KEY id
SOURCE(CLICKHOUSE(TABLE 'products' DB 'shop' USER 'shop' PASSWORD 'shop'))
LIFETIME(MIN 60 MAX 300)
LAYOUT(FLAT())
COMMENT 'Product names and prices';

CREATE OR REPLACE FUNCTION tax AS (amount) -> amount * 0.19;
