-- rebuildRequired: false, transactional: false

-- [alter] Changing a column type rewrites the column in every part (a mutation).
ALTER TABLE shop.orders MODIFY COLUMN note Nullable(VARCHAR(400));
