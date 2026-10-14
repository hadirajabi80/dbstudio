select id from orders where status = 'paid' and (total > 100 or discount is not null) and created_at between '2026-01-01' and '2026-12-31';
