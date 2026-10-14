IF @x = 1
    SELECT 1
ELSE IF @x = 2
    SELECT 2
ELSE
BEGIN
    PRINT 'other'
    SELECT 3
END
