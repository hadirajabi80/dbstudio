select stuff((select ',' + Name from Customers for xml path(''), type).value('.', 'nvarchar(max)'), 1, 1, '') as Names
