if not exists (select 1 from sys.tables where name = 'T')
begin
create table dbo.T (Id int identity(1,1) not null, Name nvarchar(50) not null, constraint PK_T primary key clustered (Id))
end
