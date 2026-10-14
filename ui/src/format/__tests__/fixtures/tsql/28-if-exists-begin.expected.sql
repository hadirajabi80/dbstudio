IF NOT EXISTS (
    SELECT 1
    FROM sys.tables
    WHERE name = 'T'
)
BEGIN
    CREATE TABLE dbo.T (
        Id INT IDENTITY(1, 1) NOT NULL,
        Name NVARCHAR(50) NOT NULL,
        CONSTRAINT PK_T PRIMARY KEY CLUSTERED (Id)
    )
END
