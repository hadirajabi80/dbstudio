$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:5121/api/v1'
$h = @{ Authorization = 'Bearer dev-token' }
$conn = @{
  name = 'Shop (SQLite)'; providerId = 'sqlite'; color = '#16a34a'; folder = $null; readOnly = $false
  props = @{ path = 'E:\DbStudio\.dev-data\shop.sqlite'; createIfMissing = $true; readOnly = $false }
  savePassword = $false; password = $null
} | ConvertTo-Json -Depth 5
$c = Invoke-RestMethod -Method Post -Uri "$base/connections" -Headers $h -ContentType 'application/json' -Body $conn
$s = Invoke-RestMethod -Method Post -Uri "$base/sessions" -Headers $h -ContentType 'application/json' -Body (@{ connectionId = $c.id; database = $null; txMode = 'auto'; captureServerOutput = $false } | ConvertTo-Json)
$stmts = @(
 'CREATE TABLE Countries (Id INTEGER PRIMARY KEY, Name TEXT NOT NULL)',
 'CREATE TABLE Customers (Id INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT NOT NULL, Email TEXT, CountryId INTEGER REFERENCES Countries(Id))',
 'CREATE TABLE Products (Id INTEGER PRIMARY KEY, Name TEXT NOT NULL, Price NUMERIC(10,2))',
 'CREATE TABLE Orders (Id INTEGER PRIMARY KEY, CustomerId INTEGER NOT NULL REFERENCES Customers(Id), OrderDate TEXT, Total NUMERIC(12,2))',
 'CREATE TABLE OrderLines (OrderId INTEGER REFERENCES Orders(Id), ProductId INTEGER REFERENCES Products(Id), Qty INTEGER, PRIMARY KEY (OrderId, ProductId))',
 'CREATE VIEW CustomerTotals AS SELECT c.Id, c.Name, SUM(o.Total) AS Total FROM Customers c JOIN Orders o ON o.CustomerId = c.Id GROUP BY c.Id, c.Name',
 "INSERT INTO Countries VALUES (1,'Iran'),(2,'Germany'),(3,'Japan')",
 "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 5000) INSERT INTO Customers (Name, Email, CountryId) SELECT 'Customer ' || i, 'c' || i || '@example.com', (i % 3) + 1 FROM n",
 "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 200) INSERT INTO Products SELECT i, 'Product ' || i, round(i * 1.7, 2) FROM n",
 "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 50000) INSERT INTO Orders SELECT i, (i % 5000) + 1, date('2025-01-01', '+' || (i % 600) || ' days'), round((i % 997) * 3.1, 2) FROM n"
)
$batches = $stmts | ForEach-Object { @{ sql = $_; line = 1; col = 1 } }
$body = @{ batches = $batches; maxRows = 100; stopOnError = $true; label = 'script'; confirmedDestructive = $true } | ConvertTo-Json -Depth 5
$x = Invoke-RestMethod -Method Post -Uri "$base/sessions/$($s.sessionId)/execute" -Headers $h -ContentType 'application/json' -Body $body
Start-Sleep -Seconds 3
Invoke-RestMethod -Method Delete -Uri "$base/sessions/$($s.sessionId)?force=true" -Headers $h | Out-Null
$hist = Invoke-RestMethod -Uri "$base/history?connectionId=$($c.id)&limit=20" -Headers $h
"connection=$($c.id) execution=$($x.executionId)"
$hist | Select-Object status, durationMs, error -First 3 | Format-Table -AutoSize | Out-String
$cat = Invoke-RestMethod -Uri "$base/connections/$($c.id)/catalog" -Headers $h
$cat.schemas | ForEach-Object { $_.name + ': ' + (($_.objects | ForEach-Object { "$($_.t):$($_.n)" }) -join ', ') }
