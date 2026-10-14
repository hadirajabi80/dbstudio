DECLARE @n INT = 0
retry:
SET @n += 1
IF @n < 3
    GOTO retry
