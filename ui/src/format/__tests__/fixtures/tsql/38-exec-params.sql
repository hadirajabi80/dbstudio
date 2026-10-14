exec dbo.SaveOrder @Id = 1, @Total = 10.5, @Note = N'x', @Result = @r output
exec sp_executesql N'select * from t where id = @id', N'@id int', @id = 5
exec dbo.Ping
