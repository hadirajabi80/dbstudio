;WITH tree (Id, ParentId, Lvl) AS (
    SELECT
        Id,
        ParentId,
        0
    FROM Nodes
    WHERE ParentId IS NULL
    UNION ALL
    SELECT
        n.Id,
        n.ParentId,
        t.Lvl + 1
    FROM Nodes n
    JOIN tree t ON t.Id = n.ParentId
)
SELECT *
FROM tree
OPTION (MAXRECURSION 100)
