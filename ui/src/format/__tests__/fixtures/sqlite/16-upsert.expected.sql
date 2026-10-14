INSERT INTO t (a, b)
VALUES (1, 2)
ON CONFLICT (a) DO UPDATE
SET
    b = excluded.b,
    c = c + 1
WHERE t.b <> excluded.b;

INSERT INTO t (a)
VALUES (3)
ON CONFLICT DO NOTHING;
