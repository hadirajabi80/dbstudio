select jt.* from orders o, json_table(o.doc, '$.lines[*]' columns (sku varchar2(20) path '$.sku', qty number path '$.qty')) jt;
