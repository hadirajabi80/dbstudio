SELECT Id
FROM dbo.Customers; -- everyone

WITH c AS (
    SELECT 1 AS x
)
SELECT x
FROM c;
