-- Rowlit "shop" fixture for MySQL 8.x and MariaDB 10.4+ (plan-batch3 WP-MY). Idempotent: drops and recreates every object.
-- Runs once from docker-entrypoint-initdb.d (mysql client, database "shop") and from the test fixture, which splits it
-- with the provider's DELIMITER-aware splitter. Same data as ShopSchema: 3 countries, 5 customers, 6 orders (order 1
-- total 120.50), 4 products, 7 order lines; plus MySQL extras: ENUM/SET/BIT/YEAR/JSON/spatial/unsigned columns, a
-- generated column, a FULLTEXT index, a CHECK constraint, views, a function, procedures (two result sets + a warning, an
-- OUT parameter), a trigger, an event, comments and Persian/Arabic/Hebrew text rows (customer_notes).
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
DROP EVENT IF EXISTS ev_purge_notes;
DROP TRIGGER IF EXISTS trg_orders_check;
DROP PROCEDURE IF EXISTS add_order_line;
DROP PROCEDURE IF EXISTS get_customer_report;
DROP PROCEDURE IF EXISTS get_customer;
DROP FUNCTION IF EXISTS fn_tax;
DROP VIEW IF EXISTS customer_totals;
DROP VIEW IF EXISTS customer_orders;
DROP TABLE IF EXISTS extra_types, customer_notes, order_lines, orders, products, customers, countries;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE countries (
  id INT NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE customers (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL COMMENT 'Display name',
  email VARCHAR(200) NULL,
  country_id INT NULL,
  CONSTRAINT fk_customers_countries FOREIGN KEY (country_id) REFERENCES countries (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = 'Registered customers';

CREATE TABLE orders (
  id INT NOT NULL PRIMARY KEY,
  customer_id INT NOT NULL,
  order_date DATETIME NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  status ENUM('new','paid','shipped','cancelled') NOT NULL DEFAULT 'new',
  KEY ix_orders_customer (customer_id),
  CONSTRAINT fk_orders_customers FOREIGN KEY (customer_id) REFERENCES customers (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE products (
  id INT NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  price DECIMAL(10,2) NULL,
  description TEXT NULL,
  CONSTRAINT ck_products_price CHECK (price >= 0),
  FULLTEXT KEY ft_products_name (name, description)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE order_lines (
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  line_total DECIMAL(12,2) GENERATED ALWAYS AS (qty * 1.0) STORED,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT fk_order_lines_orders FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT fk_order_lines_products FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE customer_notes (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  lang CHAR(2) NOT NULL,
  note TEXT NOT NULL,
  CONSTRAINT fk_customer_notes_customers FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = 'Right-to-left and mixed-direction text';

CREATE TABLE extra_types (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  u_big BIGINT UNSIGNED NULL,
  flags BIT(4) NULL,
  yr YEAR NULL,
  tags SET('vip','b2b','new') NULL,
  meta JSON NULL,
  pos POINT NULL,
  raw VARBINARY(16) NULL,
  created TIMESTAMP(6) NULL DEFAULT CURRENT_TIMESTAMP(6),
  d DATE NULL,
  t TIME(3) NULL,
  tiny TINYINT NULL,
  flag BOOLEAN NULL,
  ext_id CHAR(36) NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

INSERT INTO countries (id, name) VALUES (1, 'Germany'), (2, 'France'), (3, 'Japan');
INSERT INTO customers (name, email, country_id) VALUES
  ('Alice', 'alice@example.com', 1), ('Bob', NULL, 2), ('Chie', 'chie@example.jp', 3), ('Dora', 'dora@example.com', 1), ('Emil', NULL, NULL);
INSERT INTO products (id, name, price, description) VALUES
  (1, 'Keyboard', 49.90, 'Mechanical keyboard with brown switches'), (2, 'Mouse', 19.50, 'Wireless mouse'),
  (3, 'Monitor', 199.00, '27 inch monitor'), (4, 'Cable', 5.25, 'USB-C cable');
INSERT INTO orders (id, customer_id, order_date, total) VALUES
  (1, 1, '2026-01-05 10:00:00', 120.50), (2, 1, '2026-02-11 09:30:00', 19.50), (3, 2, '2026-02-12 14:00:00', 199.00),
  (4, 3, '2026-03-01 08:15:00', 54.15), (5, 4, '2026-03-02 17:45:00', 5.25), (6, 4, '2026-03-03 12:00:00', 249.00);
INSERT INTO order_lines (order_id, product_id, qty) VALUES (1,1,2), (1,2,1), (2,2,1), (3,3,1), (4,1,1), (4,4,1), (6,3,1);
INSERT INTO customer_notes (customer_id, lang, note) VALUES
  (1, 'fa', 'مشتری ویژه؛ تماس بعد از ساعت ۵ عصر'),
  (2, 'fa', 'Order #12 سفارش در انتظار ارسال به تهران (Tehran)'),
  (3, 'ar', 'يرجى الاتصال قبل التسليم'),
  (4, 'fa', 'خرید از فروشگاه آنلاین با کد تخفیف SUMMER-2026 و ارسال رایگان به شیراز، اصفهان و مشهد'),
  (5, 'he', 'שלום עולם');
INSERT INTO extra_types (u_big, flags, yr, tags, meta, pos, raw, created, d, t, tiny, flag, ext_id) VALUES
  (18446744073709551615, b'1010', 2026, 'vip,b2b', '{"tier": "gold", "n": 1}', ST_GeomFromText('POINT(1.5 2)'), UNHEX('DEADBEEF'),
   '2026-01-05 10:00:00.123456', '2026-03-04', '12:34:56.789', -5, TRUE, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');

CREATE VIEW customer_orders AS
SELECT c.id AS customer_id, c.name, o.id AS order_id, o.total
FROM customers c JOIN orders o ON o.customer_id = c.id;

CREATE VIEW customer_totals AS
SELECT c.id AS customer_id, c.name, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS revenue
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.name;

DELIMITER $$

CREATE FUNCTION fn_tax(amount DECIMAL(12,2)) RETURNS DECIMAL(12,2)
  DETERMINISTIC NO SQL
  COMMENT 'German VAT (19%)'
BEGIN
  RETURN amount * 0.19;
END$$

CREATE PROCEDURE get_customer(IN p_id INT)
  READS SQL DATA
BEGIN
  SELECT id, name, email, country_id FROM customers WHERE id = p_id;
END$$

-- Two result sets and, for an unknown customer, a warning (SIGNAL with a class 01 SQLSTATE; last, because every later
-- statement of the procedure would clear the diagnostics area).
CREATE PROCEDURE get_customer_report(IN p_id INT)
  READS SQL DATA
BEGIN
  DECLARE v_name VARCHAR(100);
  SELECT id, name, email FROM customers WHERE id = p_id;
  SELECT o.id, o.order_date, o.total FROM orders o WHERE o.customer_id = p_id ORDER BY o.id;
  SET v_name = (SELECT name FROM customers WHERE id = p_id);
  IF v_name IS NULL THEN
    SIGNAL SQLSTATE '01000' SET MESSAGE_TEXT = 'Customer not found', MYSQL_ERRNO = 1642;
  END IF;
END$$

CREATE PROCEDURE add_order_line(IN p_order INT, IN p_product INT, IN p_qty INT, OUT inserted INT)
  MODIFIES SQL DATA
BEGIN
  INSERT INTO order_lines (order_id, product_id, qty) VALUES (p_order, p_product, p_qty);
  SET inserted = ROW_COUNT();
END$$

CREATE TRIGGER trg_orders_check BEFORE INSERT ON orders FOR EACH ROW
BEGIN
  IF NEW.total < 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'negative total';
  END IF;
END$$

CREATE EVENT ev_purge_notes ON SCHEDULE EVERY 1 DAY DISABLE COMMENT 'Purges notes of deleted customers'
DO
BEGIN
  DELETE FROM customer_notes WHERE customer_id NOT IN (SELECT id FROM customers);
END$$

DELIMITER ;
