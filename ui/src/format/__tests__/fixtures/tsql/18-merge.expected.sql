MERGE INTO dbo.Target AS t
USING dbo.Source AS s ON t.Id = s.Id
WHEN MATCHED AND s.Deleted = 1 THEN
    DELETE
WHEN MATCHED THEN
    UPDATE SET
        t.Name = s.Name,
        t.Total = s.Total
WHEN NOT MATCHED BY TARGET THEN
    INSERT (Id, Name, Total)
    VALUES (s.Id, s.Name, s.Total)
OUTPUT $action, inserted.Id;
