-- rebuildRequired: false, transactional: true

-- [rename] Views and functions referencing the table follow the rename (views by OID); SQL in function bodies does not.
ALTER TABLE public.orders RENAME TO sales_orders;
