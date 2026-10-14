SELECT
    data->'$.a' AS a,
    data->>'$.b' AS b,
    JSON_EXTRACT(data, '$.c') c
FROM docs
WHERE JSON_VALID(data);
