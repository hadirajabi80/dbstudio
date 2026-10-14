SELECT
    id,
    CASE status
        WHEN 'n' THEN 'new'
        WHEN 'p' THEN 'paid'
        ELSE 'other'
    END AS st,
    CASE WHEN total > 100 THEN 1 ELSE 0 END AS big
FROM orders;
