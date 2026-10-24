-- rebuildRequired: false, transactional: false

-- [drop]
DROP VIEW IF EXISTS shop.v_old;

-- [create]
CREATE OR REPLACE VIEW shop.v_orders AS
SELECT id FROM shop.orders;
