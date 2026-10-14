create or replace package body order_api as
  g_calls pls_integer := 0;
  procedure log_call(p_name varchar2) is begin g_calls := g_calls + 1; dbms_output.put_line(p_name); end log_call;
  function create_order(p_customer_id in number, p_total in number) return number is
    v_id number;
  begin
    log_call('create_order');
    if p_total > c_max then raise e_invalid; end if;
    insert into orders (customer_id, total) values (p_customer_id, p_total) returning id into v_id;
    return v_id;
  end create_order;
  procedure cancel_order(p_id in number, p_reason in varchar2 default null) is
  begin
    update orders set status = 'C', note = p_reason where id = p_id;
  end cancel_order;
  function list_orders(p_customer_id number) return t_orders pipelined is
  begin
    for r in (select id, total, note from orders where customer_id = p_customer_id) loop
      pipe row (t_order(r.id, r.total, r.note));
    end loop;
    return;
  end list_orders;
begin
  g_calls := 0;
end order_api;
/
