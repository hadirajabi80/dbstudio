-- DbStudio "shop" fixture for SQL Server (docs/PLAN.md 4.14). Idempotent: drops and recreates every object.
-- Run with sqlcmd (compose service mssql-seed) or by the integration-test fixture, which splits on GO lines.
-- Data matches DbStudio.Providers.Conformance.ShopSchema: 3 countries, 5 customers, 6 orders, 4 products, 7 order lines.
IF DB_ID(N'shop') IS NULL CREATE DATABASE shop;
GO
USE shop;
GO
IF OBJECT_ID(N'dbo.Cust', N'SN') IS NOT NULL DROP SYNONYM dbo.Cust;
IF OBJECT_ID(N'dbo.OrdersOf', N'IF') IS NOT NULL DROP FUNCTION dbo.OrdersOf;
IF OBJECT_ID(N'dbo.fnTax', N'FN') IS NOT NULL DROP FUNCTION dbo.fnTax;
IF OBJECT_ID(N'dbo.GetCustomerReport', N'P') IS NOT NULL DROP PROCEDURE dbo.GetCustomerReport;
IF OBJECT_ID(N'dbo.AddOrderLines', N'P') IS NOT NULL DROP PROCEDURE dbo.AddOrderLines;
IF OBJECT_ID(N'dbo.GetCustomer', N'P') IS NOT NULL DROP PROCEDURE dbo.GetCustomer;
IF OBJECT_ID(N'dbo.CustomerOrders', N'V') IS NOT NULL DROP VIEW dbo.CustomerOrders;
IF OBJECT_ID(N'dbo.OrderNumbers', N'SO') IS NOT NULL DROP SEQUENCE dbo.OrderNumbers;
IF OBJECT_ID(N'Sales.Invoices', N'U') IS NOT NULL DROP TABLE Sales.Invoices;
IF OBJECT_ID(N'dbo.OrderLines', N'U') IS NOT NULL DROP TABLE dbo.OrderLines;
IF OBJECT_ID(N'dbo.Orders', N'U') IS NOT NULL DROP TABLE dbo.Orders;
IF OBJECT_ID(N'dbo.Products', N'U') IS NOT NULL DROP TABLE dbo.Products;
IF OBJECT_ID(N'dbo.Customers', N'U') IS NOT NULL DROP TABLE dbo.Customers;
IF OBJECT_ID(N'dbo.Countries', N'U') IS NOT NULL DROP TABLE dbo.Countries;
IF TYPE_ID(N'dbo.IdList') IS NOT NULL DROP TYPE dbo.IdList;
IF SCHEMA_ID(N'Sales') IS NULL EXEC(N'CREATE SCHEMA Sales');
GO
CREATE TABLE dbo.Countries (Id INT NOT NULL CONSTRAINT PK_Countries PRIMARY KEY, Name NVARCHAR(100) NOT NULL);
CREATE TABLE dbo.Customers (
    Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Customers PRIMARY KEY,
    Name NVARCHAR(100) NOT NULL,
    Email NVARCHAR(200) NULL,
    CountryId INT NULL CONSTRAINT FK_Customers_Countries REFERENCES dbo.Countries(Id));
CREATE TABLE dbo.Orders (
    Id INT NOT NULL CONSTRAINT PK_Orders PRIMARY KEY,
    CustomerId INT NOT NULL CONSTRAINT FK_Orders_Customers REFERENCES dbo.Customers(Id),
    OrderDate DATETIME2 NOT NULL,
    Total DECIMAL(12,2) NOT NULL);
CREATE TABLE dbo.Products (Id INT NOT NULL CONSTRAINT PK_Products PRIMARY KEY, Name NVARCHAR(100) NOT NULL, Price DECIMAL(10,2) NULL);
CREATE TABLE dbo.OrderLines (
    OrderId INT NOT NULL CONSTRAINT FK_OrderLines_Orders REFERENCES dbo.Orders(Id),
    ProductId INT NOT NULL CONSTRAINT FK_OrderLines_Products REFERENCES dbo.Products(Id),
    Qty INT NOT NULL CONSTRAINT DF_OrderLines_Qty DEFAULT 1,
    CONSTRAINT PK_OrderLines PRIMARY KEY (OrderId, ProductId));
CREATE TABLE Sales.Invoices (
    Id INT NOT NULL CONSTRAINT PK_Invoices PRIMARY KEY,
    OrderId INT NOT NULL CONSTRAINT FK_Invoices_Orders REFERENCES dbo.Orders(Id),
    Amount DECIMAL(12,2) NOT NULL);
CREATE NONCLUSTERED INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId) INCLUDE (Total);
CREATE SEQUENCE dbo.OrderNumbers AS INT START WITH 1000 INCREMENT BY 1;
CREATE TYPE dbo.IdList AS TABLE (Id INT NOT NULL PRIMARY KEY);
INSERT INTO dbo.Countries (Id, Name) VALUES (1, N'Germany'), (2, N'France'), (3, N'Japan');
INSERT INTO dbo.Customers (Name, Email, CountryId) VALUES
    (N'Alice', N'alice@example.com', 1), (N'Bob', NULL, 2), (N'Chie', N'chie@example.jp', 3),
    (N'Dora', N'dora@example.com', 1), (N'Emil', NULL, NULL);
INSERT INTO dbo.Products (Id, Name, Price) VALUES (1, N'Keyboard', 49.90), (2, N'Mouse', 19.50), (3, N'Monitor', 199.00), (4, N'Cable', 5.25);
INSERT INTO dbo.Orders (Id, CustomerId, OrderDate, Total) VALUES
    (1, 1, '2026-01-05T10:00:00', 120.50), (2, 1, '2026-02-11T09:30:00', 19.50), (3, 2, '2026-02-12T14:00:00', 199.00),
    (4, 3, '2026-03-01T08:15:00', 54.15), (5, 4, '2026-03-02T17:45:00', 5.25), (6, 4, '2026-03-03T12:00:00', 249.00);
INSERT INTO dbo.OrderLines (OrderId, ProductId, Qty) VALUES (1, 1, 2), (1, 2, 1), (2, 2, 1), (3, 3, 1), (4, 1, 1), (4, 4, 1), (6, 3, 1);
INSERT INTO Sales.Invoices (Id, OrderId, Amount) VALUES (1, 1, 120.50), (2, 3, 199.00);
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Registered customers',
    @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Customers';
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Display name',
    @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Customers',
    @level2type = N'COLUMN', @level2name = N'Name';
GO
CREATE VIEW dbo.CustomerOrders AS
SELECT c.Id AS CustomerId, c.Name, o.Id AS OrderId, o.Total
FROM dbo.Customers c JOIN dbo.Orders o ON o.CustomerId = c.Id
GO
CREATE PROCEDURE dbo.GetCustomer @Id INT AS
BEGIN
    SET NOCOUNT ON;
    SELECT Id, Name, Email, CountryId FROM dbo.Customers WHERE Id = @Id;
END
GO
-- PRINT + two result sets.
CREATE PROCEDURE dbo.GetCustomerReport @Id INT, @IncludeLines BIT = 0 AS
BEGIN
    SET NOCOUNT ON;
    PRINT N'Report for customer ' + CAST(@Id AS NVARCHAR(10));
    SELECT Id, Name, Email FROM dbo.Customers WHERE Id = @Id;
    SELECT o.Id, o.OrderDate, o.Total FROM dbo.Orders o WHERE o.CustomerId = @Id ORDER BY o.Id;
    IF @IncludeLines = 1
        SELECT l.OrderId, l.ProductId, l.Qty FROM dbo.OrderLines l JOIN dbo.Orders o ON o.Id = l.OrderId WHERE o.CustomerId = @Id;
END
GO
CREATE PROCEDURE dbo.AddOrderLines @OrderId INT, @Products dbo.IdList READONLY, @Inserted INT OUTPUT AS
BEGIN
    INSERT INTO dbo.OrderLines (OrderId, ProductId, Qty) SELECT @OrderId, p.Id, 1 FROM @Products p;
    SET @Inserted = @@ROWCOUNT;
END
GO
CREATE FUNCTION dbo.fnTax (@amount DECIMAL(12,2)) RETURNS DECIMAL(12,2) AS
BEGIN
    RETURN @amount * 0.19;
END
GO
CREATE FUNCTION dbo.OrdersOf (@CustomerId INT) RETURNS TABLE AS
RETURN SELECT o.Id, o.OrderDate, o.Total FROM dbo.Orders o WHERE o.CustomerId = @CustomerId;
GO
CREATE SYNONYM dbo.Cust FOR dbo.Customers;
GO
