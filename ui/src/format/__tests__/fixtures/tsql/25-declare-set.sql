declare @a int = 1, @b nvarchar(50) = N'x', @c datetime2(3) = sysutcdatetime()
set @a = @a + 1
select @b = Name from Customers where Id = @a
print @b
