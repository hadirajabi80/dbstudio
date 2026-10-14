EXEC dbo.SaveOrder @Id = 1,
    @Total = 10.5,
    @Note = N'x',
    @Result = @r OUTPUT

EXEC sp_executesql N'select * from t where id = @id',
    N'@id int',
    @id = 5

EXEC dbo.Ping
