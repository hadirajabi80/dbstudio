DECLARE @i INT = 0
WHILE @i < 10
BEGIN
    SET @i += 1
    IF @i % 2 = 0
        CONTINUE
    PRINT @i
END
