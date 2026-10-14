SELECT *
FROM (
    SELECT
        Year,
        Quarter,
        Amount
    FROM Sales
) s PIVOT (SUM(Amount) FOR Quarter IN ([Q1], [Q2], [Q3], [Q4])) p
