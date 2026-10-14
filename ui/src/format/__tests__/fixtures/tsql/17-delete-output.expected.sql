DELETE FROM Orders
OUTPUT deleted.Id, deleted.Total INTO @gone (Id, Total)
WHERE Total < 0
