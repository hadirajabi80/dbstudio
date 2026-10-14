insert into Log (At) values (getdate())
GO 5
select count(*) from Log
go
