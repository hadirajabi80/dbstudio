create or replace package order_api authid definer as
  c_max constant number := 1000;
  e_invalid exception;
  pragma exception_init(e_invalid, -20001);
  type t_order is record (id number, total number(12,2), note varchar2(200));
  type t_orders is table of t_order;
  function create_order(p_customer_id in number, p_total in number) return number;
  procedure cancel_order(p_id in number, p_reason in varchar2 default null);
  function list_orders(p_customer_id number) return t_orders pipelined;
end order_api;
/
