ALTER TABLE orders ADD (
    note2 VARCHAR2(100),
    status CHAR(1) DEFAULT 'N'
);

ALTER TABLE orders MODIFY (
    note VARCHAR2(400)
);

COMMENT ON COLUMN orders.note IS 'Free text';
