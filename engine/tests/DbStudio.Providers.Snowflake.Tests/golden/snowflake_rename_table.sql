-- rebuildRequired: false, transactional: false

-- [rename] Views referencing the table by name stop working until they are recreated.
ALTER TABLE PUBLIC.ORDERS RENAME TO PUBLIC.SALES_ORDERS;
