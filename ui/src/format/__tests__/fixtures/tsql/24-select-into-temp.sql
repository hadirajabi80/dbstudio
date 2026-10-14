select Id, Total into #tmp from Orders where Total > 0; select * from #tmp; drop table #tmp
