SELECT id
FROM orders
WHERE status = 'paid'
    AND (total > 100 OR discount IS NOT NULL)
    AND created_at BETWEEN '2026-01-01' AND '2026-12-31';
