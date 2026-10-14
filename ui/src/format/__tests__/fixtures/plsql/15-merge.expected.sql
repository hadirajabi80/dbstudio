MERGE INTO target t
USING (
    SELECT
        id,
        name
    FROM source
) s ON (t.id = s.id)
WHEN MATCHED THEN
    UPDATE SET t.name = s.name
    WHERE t.name <> s.name
    DELETE
    WHERE s.name IS NULL
WHEN NOT MATCHED THEN
    INSERT (id, name)
    VALUES (s.id, s.name);
