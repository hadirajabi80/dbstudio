declare @t table (Id int not null primary key, Name nvarchar(100) null, Total decimal(18, 2) default 0)
insert into @t (Id, Name) values (1, 'a')
