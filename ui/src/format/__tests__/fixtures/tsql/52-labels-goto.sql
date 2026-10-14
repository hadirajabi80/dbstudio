declare @n int = 0
retry:
set @n += 1
if @n < 3 goto retry
