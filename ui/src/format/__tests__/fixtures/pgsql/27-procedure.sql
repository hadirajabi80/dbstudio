create or replace procedure add_order_line(p_order integer, p_product integer, p_qty integer, inout inserted integer default null) language plpgsql as $proc$
begin
    insert into order_lines (order_id, product_id, qty) values (p_order, p_product, p_qty);
    inserted := 1;
end;
$proc$;
call add_order_line(1, 2, 3, null);
