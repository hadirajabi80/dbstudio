SELECT
    STUFF(
        (
            SELECT ',' + Name
            FROM Customers
            FOR XML PATH(''), TYPE
        ).value('.', 'nvarchar(max)'),
        1,
        1,
        ''
    ) AS Names
