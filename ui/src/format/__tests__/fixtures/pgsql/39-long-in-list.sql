select * from orders where status in ('new', 'paid', 'shipped', 'cancelled', 'returned', 'refunded', 'on_hold', 'backordered', 'disputed', 'archived');
