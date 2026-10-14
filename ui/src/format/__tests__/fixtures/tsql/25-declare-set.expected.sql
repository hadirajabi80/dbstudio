DECLARE @a INT = 1,
    @b NVARCHAR(50) = N'x',
    @c DATETIME2(3) = SYSUTCDATETIME()

SET @a = @a + 1
SELECT @b = Name
FROM Customers
WHERE Id = @a

PRINT @b
