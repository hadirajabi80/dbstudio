CREATE FUNCTION orders_of(p_customer INTEGER)
RETURNS TABLE (
    id INTEGER,
    order_date DATE,
    total NUMERIC
)
LANGUAGE sql
STABLE
ROWS 10
AS $$ select id, order_date, total from orders where customer_id = p_customer $$;
