GRANT SELECT, INSERT ON orders TO app_user;
TRUNCATE TABLE tmp_orders;
DROP TABLE tmp_orders PURGE;
