delete from Orders output deleted.Id, deleted.Total into @gone (Id, Total) where Total < 0
