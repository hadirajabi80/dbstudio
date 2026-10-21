SELECT *
FROM orders
WHERE status IN (
    'new',
    'paid',
    'shipped',
    'cancelled',
    'returned',
    'refunded',
    'on_hold',
    'backordered',
    'disputed',
    'archived'
);
