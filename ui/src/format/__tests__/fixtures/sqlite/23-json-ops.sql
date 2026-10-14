select data -> '$.a' as a, data ->> '$.b' as b, json_extract(data, '$.c') c from docs where json_valid(data);
