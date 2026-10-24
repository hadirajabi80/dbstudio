-- MariaDB-only extras (plan-batch3 WP-MY), applied after seed-mysql.sql on the mariadb service and by the MariaDB test
-- fixture. Idempotent.
DROP SEQUENCE IF EXISTS order_numbers;
CREATE SEQUENCE order_numbers START WITH 1000 INCREMENT BY 1 COMMENT = 'Order numbers';
