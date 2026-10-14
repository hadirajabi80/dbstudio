CREATE FUNCTION dbo.fnSplit (@s NVARCHAR(MAX), @d NCHAR(1))
RETURNS @r TABLE (
    Item NVARCHAR(4000),
    Pos INT
)
AS
BEGIN
    INSERT INTO @r (Item, Pos)
    SELECT
        value,
        ordinal
    FROM STRING_SPLIT(@s, @d, 1)
    RETURN
END
