DELETE FROM orders o
USING customers c
WHERE c.id = o.customer_id
    AND c.email IS NULL
RETURNING o.*;
