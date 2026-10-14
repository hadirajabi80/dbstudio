SELECT jt.*
FROM orders o, JSON_TABLE(o.doc, '$.lines[*]' COLUMNS (sku VARCHAR2(20) PATH '$.sku', qty NUMBER PATH '$.qty')) jt;
