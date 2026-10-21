SELECT
    COUNT(*) FILTER (WHERE status = 'paid') AS paid,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total) AS median,
    STRING_AGG(name, ', ' ORDER BY name)
FROM orders;
