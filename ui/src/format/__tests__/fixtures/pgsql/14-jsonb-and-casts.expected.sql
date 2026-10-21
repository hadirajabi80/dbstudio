SELECT
    meta -> 'a' AS a,
    meta ->> 'b' AS b,
    meta #> '{c,d}' AS cd,
    meta #>> '{e}' AS e,
    meta @> '{"x": 1}'::JSONB AS has_x,
    meta ? 'k' AS k,
    meta ?| ARRAY['a', 'b'],
    meta - 'gone',
    total::NUMERIC(10, 2),
    '2024-01-01'::DATE + 1,
    CAST(id AS TEXT)
FROM extra_types
WHERE meta <@ '{}'
    AND tags && ARRAY['t'];
