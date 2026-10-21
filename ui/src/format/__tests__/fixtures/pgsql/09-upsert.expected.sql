INSERT INTO customers (id, name, email)
VALUES (1, 'Ann', 'ann@example.com')
ON CONFLICT (id) DO UPDATE
SET
    name = EXCLUDED.name,
    email = EXCLUDED.email
WHERE customers.email IS DISTINCT FROM EXCLUDED.email
RETURNING id, name;

INSERT INTO tags (name)
VALUES ('x')
ON CONFLICT DO NOTHING;

INSERT INTO tags (name)
VALUES ('y')
ON CONFLICT ON CONSTRAINT tags_name_key DO NOTHING;
