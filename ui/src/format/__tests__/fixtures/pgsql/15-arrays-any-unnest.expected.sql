SELECT
    u.val,
    u.ord,
    tags[1],
    tags[2:3],
    ARRAY_LENGTH(tags, 1)
FROM extra_types, UNNEST(tags) WITH ORDINALITY AS u(val, ord)
WHERE 'x' = ANY(tags)
    AND id <> ALL (ARRAY[1, 2, 3]);
