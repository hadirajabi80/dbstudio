create or alter proc dbo.p (@a int, @b int = 2) with recompile as select @a + @b as s
