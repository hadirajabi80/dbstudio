SELECT
    Id,
    CASE Status
        WHEN 'n' THEN 'new'
        WHEN 'p' THEN 'paid'
        ELSE 'other'
    END AS StatusText,
    CASE WHEN Total > 100 THEN 1 ELSE 0 END AS Big
FROM Orders
