CREATE OR REPLACE PROCEDURE add_order_line(
    p_order INTEGER,
    p_product INTEGER,
    p_qty INTEGER,
    INOUT inserted INTEGER DEFAULT NULL
)
LANGUAGE plpgsql
AS $proc$
begin
    insert into order_lines (order_id, product_id, qty) values (p_order, p_product, p_qty);
    inserted := 1;
end;
$proc$;

CALL add_order_line(1, 2, 3, NULL);
