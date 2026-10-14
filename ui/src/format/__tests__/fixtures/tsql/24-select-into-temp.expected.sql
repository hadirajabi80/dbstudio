SELECT
    Id,
    Total
INTO #tmp
FROM Orders
WHERE Total > 0;

SELECT *
FROM #tmp;

DROP TABLE #tmp
