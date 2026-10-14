CREATE TEMP TRIGGER IF NOT EXISTS trg_upd
BEFORE UPDATE OF total, status ON orders
BEGIN
    SELECT RAISE(ABORT, 'locked')
    WHERE old.status = 'closed';
END;
