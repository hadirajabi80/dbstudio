DECLARE c CURSOR LOCAL FAST_FORWARD FOR
    SELECT
        Id,
        Name
    FROM Customers
    WHERE Active = 1

OPEN c
FETCH NEXT FROM c INTO @id, @name
WHILE @@fetch_status = 0
BEGIN
    PRINT @name
    FETCH NEXT FROM c INTO @id, @name
END

CLOSE c
DEALLOCATE c
