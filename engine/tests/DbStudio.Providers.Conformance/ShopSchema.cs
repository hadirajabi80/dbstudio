using System.Text;
using DbStudio.Core.Models;

namespace DbStudio.Providers.Conformance;

/// <summary>
/// The "shop" fixture schema of docs/PLAN.md 4.14 in the three dialects, plus the logical→physical name mapping.
/// Logical names are the T-SQL ones (PascalCase): Oracle uses UPPER_SNAKE (CUSTOMERS, COUNTRY_ID), SQLite lower_snake
/// (customers, country_id).
/// <list type="bullet">
/// <item>Countries(Id PK, Name)</item>
/// <item>Customers(Id PK identity, Name, Email, CountryId FK→Countries.Id)</item>
/// <item>Orders(Id PK, CustomerId FK→Customers.Id, OrderDate, Total decimal)</item>
/// <item>Products(Id PK, Name, Price)</item>
/// <item>OrderLines(OrderId FK→Orders.Id, ProductId FK→Products.Id, Qty; PK(OrderId, ProductId))</item>
/// <item>view CustomerOrders(CustomerId, Name, OrderId, Total)</item>
/// <item>T-SQL extras: Sales.Invoices, proc dbo.GetCustomer(@Id int), fn dbo.fnTax(@amount decimal), synonym dbo.Cust</item>
/// <item>Oracle extras: package ORDER_API, sequence ORDERS_SEQ, synonym CUST</item>
/// <item>SQLite extras: index ix_orders_customer, trigger trg_orders_total_check</item>
/// </list>
/// Data: 3 countries, 5 customers, 6 orders (order 1 total 120.50), 4 products, 7 order lines.
/// </summary>
public static class ShopSchema
{
    public const int CustomerCount = 5;
    public const int OrderCount = 6;
    public const decimal Order1Total = 120.50m;

    /// <summary>Maps a logical (T-SQL PascalCase) identifier to the dialect's physical name.</summary>
    public static string Name(Dialect dialect, string logical) => dialect switch
    {
        Dialect.TSql => logical,
        Dialect.PlSql => ToSnake(logical).ToUpperInvariant(),
        Dialect.Sqlite or Dialect.PgSql => ToSnake(logical).ToLowerInvariant(),
        _ => logical,
    };

    public static string ToSnake(string pascal)
    {
        var sb = new StringBuilder(pascal.Length + 4);
        for (var i = 0; i < pascal.Length; i++)
        {
            var c = pascal[i];
            if (i > 0 && char.IsUpper(c) && (char.IsLower(pascal[i - 1]) || (i + 1 < pascal.Length && char.IsLower(pascal[i + 1]) && char.IsUpper(pascal[i - 1]))))
                sb.Append('_');
            sb.Append(c);
        }
        return sb.ToString();
    }

    /// <summary>Default schema holding the shop objects: dbo / SHOP / main.</summary>
    public static string DefaultSchema(Dialect dialect) => dialect switch
    {
        Dialect.TSql => "dbo",
        Dialect.PlSql => "SHOP",
        Dialect.PgSql => "public",
        _ => "main",
    };

    /// <summary>Seed batches (each one executed as its own batch; idempotent: drops existing objects first).</summary>
    public static IReadOnlyList<string> Seed(Dialect dialect) => dialect switch
    {
        Dialect.TSql => TSqlSeed,
        Dialect.PlSql => PlSqlSeed,
        Dialect.Sqlite => SqliteSeed,
        _ => throw new ArgumentOutOfRangeException(nameof(dialect)),
    };

    private static readonly string[] TSqlSeed =
    [
        """
        IF OBJECT_ID('dbo.Cust', 'SN') IS NOT NULL DROP SYNONYM dbo.Cust;
        IF OBJECT_ID('dbo.CustomerOrders', 'V') IS NOT NULL DROP VIEW dbo.CustomerOrders;
        IF OBJECT_ID('dbo.GetCustomer', 'P') IS NOT NULL DROP PROCEDURE dbo.GetCustomer;
        IF OBJECT_ID('dbo.fnTax', 'FN') IS NOT NULL DROP FUNCTION dbo.fnTax;
        IF OBJECT_ID('Sales.Invoices', 'U') IS NOT NULL DROP TABLE Sales.Invoices;
        IF OBJECT_ID('dbo.OrderLines', 'U') IS NOT NULL DROP TABLE dbo.OrderLines;
        IF OBJECT_ID('dbo.Orders', 'U') IS NOT NULL DROP TABLE dbo.Orders;
        IF OBJECT_ID('dbo.Products', 'U') IS NOT NULL DROP TABLE dbo.Products;
        IF OBJECT_ID('dbo.Customers', 'U') IS NOT NULL DROP TABLE dbo.Customers;
        IF OBJECT_ID('dbo.Countries', 'U') IS NOT NULL DROP TABLE dbo.Countries;
        IF SCHEMA_ID('Sales') IS NULL EXEC('CREATE SCHEMA Sales');
        """,
        """
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
        CREATE TABLE Sales.Invoices (Id INT NOT NULL CONSTRAINT PK_Invoices PRIMARY KEY, OrderId INT NOT NULL CONSTRAINT FK_Invoices_Orders REFERENCES dbo.Orders(Id), Amount DECIMAL(12,2) NOT NULL);
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
        """,
        """
        CREATE VIEW dbo.CustomerOrders AS
        SELECT c.Id AS CustomerId, c.Name, o.Id AS OrderId, o.Total
        FROM dbo.Customers c JOIN dbo.Orders o ON o.CustomerId = c.Id
        """,
        """
        CREATE PROCEDURE dbo.GetCustomer @Id INT AS
        BEGIN
            SET NOCOUNT ON;
            SELECT Id, Name, Email, CountryId FROM dbo.Customers WHERE Id = @Id;
        END
        """,
        """
        CREATE FUNCTION dbo.fnTax (@amount DECIMAL(12,2)) RETURNS DECIMAL(12,2) AS
        BEGIN
            RETURN @amount * 0.19;
        END
        """,
        "CREATE SYNONYM dbo.Cust FOR dbo.Customers",
    ];

    private static readonly string[] PlSqlSeed =
    [
        """
        BEGIN
          FOR o IN (SELECT object_name, object_type FROM user_objects
                    WHERE object_name IN ('CUST','CUSTOMER_ORDERS','ORDER_API','ORDERS_SEQ','ORDER_LINES','ORDERS','PRODUCTS','CUSTOMERS','COUNTRIES')
                      AND object_type IN ('SYNONYM','VIEW','PACKAGE','SEQUENCE','TABLE')
                    ORDER BY DECODE(object_type, 'SYNONYM', 1, 'VIEW', 2, 'PACKAGE', 3, 'SEQUENCE', 4, 5)) LOOP
            EXECUTE IMMEDIATE 'DROP ' || o.object_type || ' "' || o.object_name || '"'
              || CASE WHEN o.object_type = 'TABLE' THEN ' CASCADE CONSTRAINTS PURGE' END;
          END LOOP;
        END;
        """,
        "CREATE TABLE COUNTRIES (ID NUMBER(10) CONSTRAINT PK_COUNTRIES PRIMARY KEY, NAME VARCHAR2(100) NOT NULL)",
        """
        CREATE TABLE CUSTOMERS (
          ID NUMBER(10) GENERATED BY DEFAULT AS IDENTITY CONSTRAINT PK_CUSTOMERS PRIMARY KEY,
          NAME VARCHAR2(100) NOT NULL,
          EMAIL VARCHAR2(200),
          COUNTRY_ID NUMBER(10) CONSTRAINT FK_CUSTOMERS_COUNTRIES REFERENCES COUNTRIES(ID))
        """,
        """
        CREATE TABLE ORDERS (
          ID NUMBER(10) CONSTRAINT PK_ORDERS PRIMARY KEY,
          CUSTOMER_ID NUMBER(10) NOT NULL CONSTRAINT FK_ORDERS_CUSTOMERS REFERENCES CUSTOMERS(ID),
          ORDER_DATE DATE NOT NULL,
          TOTAL NUMBER(12,2) NOT NULL)
        """,
        "CREATE TABLE PRODUCTS (ID NUMBER(10) CONSTRAINT PK_PRODUCTS PRIMARY KEY, NAME VARCHAR2(100) NOT NULL, PRICE NUMBER(10,2))",
        """
        CREATE TABLE ORDER_LINES (
          ORDER_ID NUMBER(10) NOT NULL CONSTRAINT FK_ORDER_LINES_ORDERS REFERENCES ORDERS(ID),
          PRODUCT_ID NUMBER(10) NOT NULL CONSTRAINT FK_ORDER_LINES_PRODUCTS REFERENCES PRODUCTS(ID),
          QTY NUMBER(10) DEFAULT 1 NOT NULL,
          CONSTRAINT PK_ORDER_LINES PRIMARY KEY (ORDER_ID, PRODUCT_ID))
        """,
        """
        BEGIN
          INSERT INTO COUNTRIES (ID, NAME) VALUES (1, 'Germany');
          INSERT INTO COUNTRIES (ID, NAME) VALUES (2, 'France');
          INSERT INTO COUNTRIES (ID, NAME) VALUES (3, 'Japan');
          INSERT INTO CUSTOMERS (NAME, EMAIL, COUNTRY_ID) VALUES ('Alice', 'alice@example.com', 1);
          INSERT INTO CUSTOMERS (NAME, EMAIL, COUNTRY_ID) VALUES ('Bob', NULL, 2);
          INSERT INTO CUSTOMERS (NAME, EMAIL, COUNTRY_ID) VALUES ('Chie', 'chie@example.jp', 3);
          INSERT INTO CUSTOMERS (NAME, EMAIL, COUNTRY_ID) VALUES ('Dora', 'dora@example.com', 1);
          INSERT INTO CUSTOMERS (NAME, EMAIL, COUNTRY_ID) VALUES ('Emil', NULL, NULL);
          INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES (1, 'Keyboard', 49.90);
          INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES (2, 'Mouse', 19.50);
          INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES (3, 'Monitor', 199.00);
          INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES (4, 'Cable', 5.25);
          INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_DATE, TOTAL) VALUES (1, 1, DATE '2026-01-05', 120.50);
          INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_DATE, TOTAL) VALUES (2, 1, DATE '2026-02-11', 19.50);
          INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_DATE, TOTAL) VALUES (3, 2, DATE '2026-02-12', 199.00);
          INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_DATE, TOTAL) VALUES (4, 3, DATE '2026-03-01', 54.15);
          INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_DATE, TOTAL) VALUES (5, 4, DATE '2026-03-02', 5.25);
          INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_DATE, TOTAL) VALUES (6, 4, DATE '2026-03-03', 249.00);
          INSERT INTO ORDER_LINES (ORDER_ID, PRODUCT_ID, QTY) VALUES (1, 1, 2);
          INSERT INTO ORDER_LINES (ORDER_ID, PRODUCT_ID, QTY) VALUES (1, 2, 1);
          INSERT INTO ORDER_LINES (ORDER_ID, PRODUCT_ID, QTY) VALUES (2, 2, 1);
          INSERT INTO ORDER_LINES (ORDER_ID, PRODUCT_ID, QTY) VALUES (3, 3, 1);
          INSERT INTO ORDER_LINES (ORDER_ID, PRODUCT_ID, QTY) VALUES (4, 1, 1);
          INSERT INTO ORDER_LINES (ORDER_ID, PRODUCT_ID, QTY) VALUES (4, 4, 1);
          INSERT INTO ORDER_LINES (ORDER_ID, PRODUCT_ID, QTY) VALUES (6, 3, 1);
          COMMIT;
        END;
        """,
        """
        CREATE VIEW CUSTOMER_ORDERS AS
        SELECT c.ID AS CUSTOMER_ID, c.NAME, o.ID AS ORDER_ID, o.TOTAL
        FROM CUSTOMERS c JOIN ORDERS o ON o.CUSTOMER_ID = c.ID
        """,
        "CREATE SEQUENCE ORDERS_SEQ START WITH 100",
        "CREATE SYNONYM CUST FOR CUSTOMERS",
        """
        CREATE OR REPLACE PACKAGE ORDER_API AS
          PROCEDURE CREATE_ORDER(p_cust IN NUMBER, p_total IN NUMBER);
          FUNCTION GET_TOTAL(p_id NUMBER) RETURN NUMBER;
        END ORDER_API;
        """,
        """
        CREATE OR REPLACE PACKAGE BODY ORDER_API AS
          PROCEDURE CREATE_ORDER(p_cust IN NUMBER, p_total IN NUMBER) IS
          BEGIN
            INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_DATE, TOTAL) VALUES (ORDERS_SEQ.NEXTVAL, p_cust, SYSDATE, p_total);
          END CREATE_ORDER;
          FUNCTION GET_TOTAL(p_id NUMBER) RETURN NUMBER IS
            v NUMBER;
          BEGIN
            SELECT TOTAL INTO v FROM ORDERS WHERE ID = p_id;
            RETURN v;
          END GET_TOTAL;
        END ORDER_API;
        """,
    ];

    private static readonly string[] SqliteSeed =
    [
        "DROP VIEW IF EXISTS customer_orders",
        "DROP TABLE IF EXISTS order_lines",
        "DROP TABLE IF EXISTS orders",
        "DROP TABLE IF EXISTS products",
        "DROP TABLE IF EXISTS customers",
        "DROP TABLE IF EXISTS countries",
        "CREATE TABLE countries (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
        """
        CREATE TABLE customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT,
          country_id INTEGER CONSTRAINT fk_customers_countries REFERENCES countries(id))
        """,
        """
        CREATE TABLE orders (
          id INTEGER PRIMARY KEY,
          customer_id INTEGER NOT NULL REFERENCES customers(id),
          order_date DATETIME NOT NULL,
          total DECIMAL(12,2) NOT NULL)
        """,
        "CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price DECIMAL(10,2))",
        """
        CREATE TABLE order_lines (
          order_id INTEGER NOT NULL REFERENCES orders(id),
          product_id INTEGER NOT NULL REFERENCES products(id),
          qty INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (order_id, product_id)) WITHOUT ROWID
        """,
        "CREATE INDEX ix_orders_customer ON orders(customer_id)",
        """
        CREATE VIEW customer_orders AS
        SELECT c.id AS customer_id, c.name, o.id AS order_id, o.total
        FROM customers c JOIN orders o ON o.customer_id = c.id
        """,
        """
        CREATE TRIGGER trg_orders_total_check BEFORE INSERT ON orders
        WHEN NEW.total < 0
        BEGIN
          SELECT RAISE(ABORT, 'negative total');
        END
        """,
        "INSERT INTO countries (id, name) VALUES (1, 'Germany'), (2, 'France'), (3, 'Japan')",
        """
        INSERT INTO customers (name, email, country_id) VALUES
          ('Alice', 'alice@example.com', 1), ('Bob', NULL, 2), ('Chie', 'chie@example.jp', 3),
          ('Dora', 'dora@example.com', 1), ('Emil', NULL, NULL)
        """,
        "INSERT INTO products (id, name, price) VALUES (1, 'Keyboard', 49.90), (2, 'Mouse', 19.50), (3, 'Monitor', 199.00), (4, 'Cable', 5.25)",
        """
        INSERT INTO orders (id, customer_id, order_date, total) VALUES
          (1, 1, '2026-01-05 10:00:00', 120.50), (2, 1, '2026-02-11 09:30:00', 19.50), (3, 2, '2026-02-12 14:00:00', 199.00),
          (4, 3, '2026-03-01 08:15:00', 54.15), (5, 4, '2026-03-02 17:45:00', 5.25), (6, 4, '2026-03-03 12:00:00', 249.00)
        """,
        "INSERT INTO order_lines (order_id, product_id, qty) VALUES (1, 1, 2), (1, 2, 1), (2, 2, 1), (3, 3, 1), (4, 1, 1), (4, 4, 1), (6, 3, 1)",
    ];
}
