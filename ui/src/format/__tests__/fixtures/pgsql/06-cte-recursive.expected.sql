WITH RECURSIVE tree AS (
    SELECT
        id,
        parent_id,
        name,
        1 AS depth
    FROM categories
    WHERE parent_id IS NULL
    UNION ALL
    SELECT
        c.id,
        c.parent_id,
        c.name,
        t.depth + 1
    FROM categories c
    JOIN tree t ON t.id = c.parent_id
)
SELECT *
FROM tree
ORDER BY depth;
