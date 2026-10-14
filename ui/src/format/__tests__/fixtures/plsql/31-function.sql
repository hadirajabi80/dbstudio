create or replace function order_total(p_order_id in orders.id%type) return number deterministic is v_total number; begin select sum(qty * price) into v_total from order_lines where order_id = p_order_id; return nvl(v_total, 0); end order_total;
/
