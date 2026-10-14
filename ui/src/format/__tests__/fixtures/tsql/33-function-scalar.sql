create function dbo.fnTax (@amount decimal(18,2), @rate decimal(5,4)) returns decimal(18,2) with schemabinding as begin declare @r decimal(18,2) = @amount * @rate; return @r; end
