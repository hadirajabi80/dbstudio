using System.Globalization;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using Microsoft.Data.Sqlite;

namespace DbStudio.Core.Sample;

/// <summary>Result of <see cref="SampleDatabase.EnsureAsync"/> (POST /sample-db).</summary>
public sealed record SampleDbResult(string Path, string ConnectionId, ConnectionProfile Profile, bool Created);

/// <summary>
/// The "Try the sample database" fixture (docs/PLAN-M1.5.md section 3 onboarding): a SQLite "shop" database under
/// <c>&lt;data dir&gt;/sample/shop.sqlite</c> with countries, customers, products, orders and order lines
/// (deterministic, realistic data), a view, indexes, check constraints and triggers, plus a connection profile
/// "Sample: Shop". Idempotent: an existing file and profile are reused unless <c>reset</c> is requested.
/// </summary>
public sealed class SampleDatabase(AppPaths paths, ConnectionStore connections)
{
    public const string ProfileName = "Sample: Shop";
    public const int CountryCount = 24, CustomerCount = 300, ProductCount = 60, OrderCount = 1500;

    public string FilePath => System.IO.Path.Combine(paths.DataDir, "sample", "shop.sqlite");

    /// <param name="reset">Recreate the file (callers close sessions on the sample connection first).</param>
    public async Task<SampleDbResult> EnsureAsync(bool reset, CancellationToken ct)
    {
        var path = FilePath;
        var created = false;
        if (reset || !File.Exists(path))
        {
            await CreateAsync(path, ct).ConfigureAwait(false);
            created = true;
        }

        var profile = FindProfile(path);
        if (profile is null)
        {
            profile = connections.Create(new ConnectionProfile
            {
                Name = ProfileName,
                ProviderId = "sqlite",
                Color = "#16a34a",
                Folder = null,
                ReadOnly = false,
                SavePassword = false,
                Props = new Dictionary<string, JsonNode?>
                {
                    ["path"] = path,
                    ["readOnly"] = false,
                    ["createIfMissing"] = false,
                },
            }, null);
        }
        return new SampleDbResult(path, profile.Id, profile, created);
    }

    /// <summary>The existing profile pointing at the sample file, if any.</summary>
    public ConnectionProfile? FindProfile(string? path = null)
    {
        var target = System.IO.Path.GetFullPath(path ?? FilePath);
        var comparison = OperatingSystem.IsLinux() ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
        return connections.List().FirstOrDefault(p =>
            p.ProviderId.Equals("sqlite", StringComparison.OrdinalIgnoreCase)
            && p.GetString("path") is { Length: > 0 } pp
            && string.Equals(SafeFullPath(pp), target, comparison));
    }

    private static string SafeFullPath(string p)
    {
        try { return System.IO.Path.GetFullPath(Environment.ExpandEnvironmentVariables(p)); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { return p; }
    }

    /// <summary>Builds the database in a temp file next to <paramref name="path"/> and moves it into place.</summary>
    public static async Task CreateAsync(string path, CancellationToken ct)
    {
        var dir = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path))!;
        Directory.CreateDirectory(dir);
        var temp = System.IO.Path.Combine(dir, $".shop.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var c = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = temp, Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false, ForeignKeys = true }.ToString()))
            {
                await c.OpenAsync(ct).ConfigureAwait(false);
                await SeedAsync(c, ct).ConfigureAwait(false);
            }
            SqliteConnection.ClearAllPools();
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp))
            {
                try { File.Delete(temp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }

    public const string Schema = """
        CREATE TABLE Countries (
            Id INTEGER NOT NULL PRIMARY KEY,
            Code TEXT NOT NULL,
            Name TEXT NOT NULL,
            Region TEXT NOT NULL,
            CONSTRAINT UQ_Countries_Code UNIQUE (Code)
        );
        CREATE TABLE Customers (
            Id INTEGER NOT NULL CONSTRAINT PK_Customers PRIMARY KEY AUTOINCREMENT,
            FirstName TEXT NOT NULL,
            LastName TEXT NOT NULL,
            Email TEXT NOT NULL,
            Phone TEXT,
            City TEXT,
            CountryId INTEGER NOT NULL,
            IsActive BOOLEAN NOT NULL DEFAULT 1,
            CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT UQ_Customers_Email UNIQUE (Email),
            CONSTRAINT FK_Customers_Countries FOREIGN KEY (CountryId) REFERENCES Countries (Id)
        );
        CREATE TABLE Products (
            Id INTEGER NOT NULL PRIMARY KEY,
            Sku TEXT NOT NULL,
            Name TEXT NOT NULL,
            Category TEXT NOT NULL,
            Price NUMERIC(10,2) NOT NULL,
            Stock INTEGER NOT NULL DEFAULT 0,
            Discontinued BOOLEAN NOT NULL DEFAULT 0,
            CONSTRAINT UQ_Products_Sku UNIQUE (Sku),
            CONSTRAINT CK_Products_Price CHECK (Price >= 0)
        );
        CREATE TABLE Orders (
            Id INTEGER NOT NULL PRIMARY KEY,
            CustomerId INTEGER NOT NULL,
            OrderDate DATE NOT NULL,
            Status TEXT NOT NULL DEFAULT 'new',
            ShippedAt DATETIME,
            Total NUMERIC(12,2) NOT NULL DEFAULT 0,
            Note TEXT,
            CONSTRAINT FK_Orders_Customers FOREIGN KEY (CustomerId) REFERENCES Customers (Id),
            CONSTRAINT CK_Orders_Status CHECK (Status IN ('new', 'paid', 'shipped', 'delivered', 'cancelled'))
        );
        CREATE TABLE OrderLines (
            OrderId INTEGER NOT NULL,
            LineNo INTEGER NOT NULL,
            ProductId INTEGER NOT NULL,
            Qty INTEGER NOT NULL,
            UnitPrice NUMERIC(10,2) NOT NULL,
            Discount NUMERIC(4,2) NOT NULL DEFAULT 0,
            CONSTRAINT PK_OrderLines PRIMARY KEY (OrderId, LineNo),
            CONSTRAINT FK_OrderLines_Orders FOREIGN KEY (OrderId) REFERENCES Orders (Id) ON DELETE CASCADE,
            CONSTRAINT FK_OrderLines_Products FOREIGN KEY (ProductId) REFERENCES Products (Id),
            CONSTRAINT CK_OrderLines_Qty CHECK (Qty > 0)
        );
        CREATE INDEX IX_Customers_LastName ON Customers (LastName, FirstName);
        CREATE INDEX IX_Orders_CustomerId ON Orders (CustomerId);
        CREATE INDEX IX_Orders_OrderDate ON Orders (OrderDate DESC);
        CREATE INDEX IX_OrderLines_ProductId ON OrderLines (ProductId);
        CREATE TRIGGER TR_OrderLines_Insert AFTER INSERT ON OrderLines
        BEGIN
            UPDATE Orders SET Total = (SELECT round(coalesce(sum(Qty * UnitPrice * (1 - Discount)), 0), 2) FROM OrderLines WHERE OrderId = NEW.OrderId)
            WHERE Id = NEW.OrderId;
        END;
        CREATE TRIGGER TR_OrderLines_Delete AFTER DELETE ON OrderLines
        BEGIN
            UPDATE Orders SET Total = (SELECT round(coalesce(sum(Qty * UnitPrice * (1 - Discount)), 0), 2) FROM OrderLines WHERE OrderId = OLD.OrderId)
            WHERE Id = OLD.OrderId;
        END;
        CREATE VIEW CustomerOrderTotals AS
        SELECT c.Id AS CustomerId,
               c.FirstName || ' ' || c.LastName AS CustomerName,
               co.Name AS Country,
               count(o.Id) AS Orders,
               round(coalesce(sum(o.Total), 0), 2) AS Revenue,
               max(o.OrderDate) AS LastOrder
        FROM Customers c
        JOIN Countries co ON co.Id = c.CountryId
        LEFT JOIN Orders o ON o.CustomerId = c.Id AND o.Status <> 'cancelled'
        GROUP BY c.Id, c.FirstName, c.LastName, co.Name;
        """;

    private static readonly (string Code, string Name, string Region, string[] Cities)[] Countries =
    [
        ("US", "United States", "Americas", ["New York", "Chicago", "Seattle", "Austin"]),
        ("CA", "Canada", "Americas", ["Toronto", "Vancouver", "Montreal"]),
        ("MX", "Mexico", "Americas", ["Mexico City", "Guadalajara"]),
        ("BR", "Brazil", "Americas", ["São Paulo", "Rio de Janeiro"]),
        ("AR", "Argentina", "Americas", ["Buenos Aires", "Córdoba"]),
        ("GB", "United Kingdom", "Europe", ["London", "Manchester", "Edinburgh"]),
        ("DE", "Germany", "Europe", ["Berlin", "Munich", "Hamburg"]),
        ("FR", "France", "Europe", ["Paris", "Lyon", "Marseille"]),
        ("ES", "Spain", "Europe", ["Madrid", "Barcelona", "Valencia"]),
        ("IT", "Italy", "Europe", ["Rome", "Milan", "Turin"]),
        ("NL", "Netherlands", "Europe", ["Amsterdam", "Rotterdam"]),
        ("SE", "Sweden", "Europe", ["Stockholm", "Gothenburg"]),
        ("PL", "Poland", "Europe", ["Warsaw", "Kraków"]),
        ("TR", "Türkiye", "Europe", ["Istanbul", "Ankara"]),
        ("IR", "Iran", "Asia", ["Tehran", "Isfahan", "Shiraz"]),
        ("IN", "India", "Asia", ["Mumbai", "Bengaluru", "Delhi"]),
        ("CN", "China", "Asia", ["Shanghai", "Beijing", "Shenzhen"]),
        ("JP", "Japan", "Asia", ["Tokyo", "Osaka", "Kyoto"]),
        ("KR", "South Korea", "Asia", ["Seoul", "Busan"]),
        ("SG", "Singapore", "Asia", ["Singapore"]),
        ("AE", "United Arab Emirates", "Asia", ["Dubai", "Abu Dhabi"]),
        ("AU", "Australia", "Oceania", ["Sydney", "Melbourne", "Brisbane"]),
        ("ZA", "South Africa", "Africa", ["Cape Town", "Johannesburg"]),
        ("EG", "Egypt", "Africa", ["Cairo", "Alexandria"]),
    ];

    private static readonly string[] FirstNames =
    [
        "Olivia", "Liam", "Emma", "Noah", "Ava", "Elijah", "Sophia", "Lucas", "Mia", "Mateo", "Amelia", "Levi", "Harper",
        "Ethan", "Sara", "Ali", "Yuki", "Hana", "Arjun", "Priya", "Chen", "Mei", "Lukas", "Anna", "Hugo", "Léa",
        "Marco", "Giulia", "Carlos", "Lucía", "Omar", "Layla", "Reza", "Nasrin", "Jonas", "Ingrid", "Kofi", "Amara",
    ];

    private static readonly string[] LastNames =
    [
        "Smith", "Johnson", "Brown", "Garcia", "Miller", "Davis", "Martinez", "Wilson", "Anderson", "Taylor", "Moore",
        "Müller", "Schmidt", "Rossi", "Bianchi", "Dubois", "Martin", "Fernández", "López", "Kowalski", "Nowak",
        "Ahmadi", "Karimi", "Tanaka", "Suzuki", "Kim", "Park", "Wang", "Li", "Patel", "Sharma", "Silva", "Santos",
        "Andersson", "Jansen", "de Vries", "Yılmaz", "Okafor", "Haddad",
    ];

    private static readonly (string Category, string[] Items, decimal MinPrice, decimal MaxPrice)[] Catalog =
    [
        ("Laptops", ["Ultrabook 13", "Ultrabook 15", "Workstation 16", "Chromebook 14", "Gaming Laptop 17"], 499m, 2899m),
        ("Monitors", ["27\" 4K Monitor", "24\" IPS Monitor", "34\" Ultrawide", "32\" Curved", "Portable 15\" Display"], 129m, 999m),
        ("Peripherals", ["Mechanical Keyboard", "Wireless Mouse", "Ergonomic Mouse", "USB-C Dock", "Webcam 1080p", "Webcam 4K", "Headset Pro", "Desk Microphone"], 19m, 349m),
        ("Storage", ["NVMe SSD 1TB", "NVMe SSD 2TB", "Portable SSD 1TB", "External HDD 4TB", "USB Stick 128GB", "NAS 2-Bay"], 14m, 599m),
        ("Networking", ["Wi-Fi 6 Router", "Mesh System (3)", "8-Port Switch", "Network Card 10GbE", "Powerline Kit"], 29m, 449m),
        ("Office", ["Standing Desk", "Office Chair", "Monitor Arm", "Desk Lamp", "Cable Kit", "Laptop Stand", "Whiteboard"], 9m, 799m),
        ("Software", ["Office Suite (1 yr)", "Antivirus (1 yr)", "Backup Cloud 1TB", "Design Suite", "IDE License"], 39m, 699m),
        ("Audio", ["Noise-Cancelling Headphones", "Bluetooth Speaker", "Studio Monitors (pair)", "Earbuds", "DAC/Amp"], 39m, 549m),
        ("Phones", ["Smartphone 128GB", "Smartphone 256GB", "Phone Case", "Charger 65W", "Power Bank 20k"], 15m, 1199m),
        ("Cables", ["HDMI 2.1 Cable", "USB-C Cable 2m", "DisplayPort Cable", "Ethernet Cable 10m", "Thunderbolt 4 Cable"], 7m, 59m),
    ];

    private static readonly string[] Statuses = ["delivered", "delivered", "delivered", "shipped", "paid", "new", "cancelled"];

    private static async Task SeedAsync(SqliteConnection c, CancellationToken ct)
    {
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "PRAGMA journal_mode = DELETE;";
            await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
        await using var tx = (SqliteTransaction)await c.BeginTransactionAsync(ct).ConfigureAwait(false);
        await using (var cmd = c.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = Schema;
            await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }

        var rnd = new Random(2026);
        var inv = CultureInfo.InvariantCulture;

        await using (var cmd = Insert(c, tx, "INSERT INTO Countries (Id, Code, Name, Region) VALUES ($id, $code, $name, $region)", "$id", "$code", "$name", "$region"))
        {
            for (var i = 0; i < Countries.Length; i++)
                await Run(cmd, ct, i + 1, Countries[i].Code, Countries[i].Name, Countries[i].Region).ConfigureAwait(false);
        }

        var baseDate = new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Unspecified);
        await using (var cmd = Insert(c, tx,
            "INSERT INTO Customers (FirstName, LastName, Email, Phone, City, CountryId, IsActive, CreatedAt) VALUES ($f, $l, $e, $p, $city, $country, $active, $created)",
            "$f", "$l", "$e", "$p", "$city", "$country", "$active", "$created"))
        {
            var emails = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (var i = 1; i <= CustomerCount; i++)
            {
                var first = FirstNames[rnd.Next(FirstNames.Length)];
                var last = LastNames[rnd.Next(LastNames.Length)];
                var countryIndex = rnd.Next(Countries.Length);
                var country = Countries[countryIndex];
                var city = country.Cities[rnd.Next(country.Cities.Length)];
                var local = $"{Ascii(first)}.{Ascii(last)}".ToLowerInvariant();
                var email = $"{local}@example.com";
                for (var n = 2; !emails.Add(email); n++) email = $"{local}{n}@example.com";
                object? phone = rnd.Next(5) == 0 ? null : $"+{rnd.Next(1, 99)} {rnd.Next(100, 999)} {rnd.Next(1000, 9999)}";
                var created = baseDate.AddMinutes(rnd.Next(0, 60 * 24 * 365));
                await Run(cmd, ct, first, last, email, phone, city, countryIndex + 1, rnd.Next(10) == 0 ? 0 : 1,
                    created.ToString("yyyy-MM-dd HH:mm:ss", inv)).ConfigureAwait(false);
            }
        }

        var prices = new List<decimal>();
        await using (var cmd = Insert(c, tx,
            "INSERT INTO Products (Id, Sku, Name, Category, Price, Stock, Discontinued) VALUES ($id, $sku, $name, $cat, $price, $stock, $disc)",
            "$id", "$sku", "$name", "$cat", "$price", "$stock", "$disc"))
        {
            var id = 0;
            foreach (var (category, items, min, max) in Catalog)
            {
                foreach (var item in items)
                {
                    if (id >= ProductCount) break;
                    id++;
                    var price = Math.Round(min + (decimal)rnd.NextDouble() * (max - min), 0) - 0.01m;
                    if (price < 1) price = 0.99m;
                    prices.Add(price);
                    var sku = $"{category[..3].ToUpperInvariant()}-{id:D4}";
                    await Run(cmd, ct, id, sku, item, category, (double)price, rnd.Next(0, 400), rnd.Next(15) == 0 ? 1 : 0).ConfigureAwait(false);
                }
            }
            while (id < ProductCount)
            {
                id++;
                var price = Math.Round(5m + (decimal)rnd.NextDouble() * 95m, 2);
                prices.Add(price);
                await Run(cmd, ct, id, $"ACC-{id:D4}", $"Accessory #{id}", "Accessories", (double)price, rnd.Next(0, 500), 0).ConfigureAwait(false);
            }
        }

        await using var order = Insert(c, tx,
            "INSERT INTO Orders (Id, CustomerId, OrderDate, Status, ShippedAt, Note) VALUES ($id, $cust, $date, $status, $shipped, $note)",
            "$id", "$cust", "$date", "$status", "$shipped", "$note");
        await using var line = Insert(c, tx,
            "INSERT INTO OrderLines (OrderId, LineNo, ProductId, Qty, UnitPrice, Discount) VALUES ($o, $n, $p, $q, $u, $d)",
            "$o", "$n", "$p", "$q", "$u", "$d");
        string[] notes = ["Leave at the front desk", "Gift wrap, please", "Call before delivery", "Urgent", "Invoice to accounting"];
        for (var i = 1; i <= OrderCount; i++)
        {
            var date = baseDate.AddDays(rnd.Next(0, 640)).AddMinutes(rnd.Next(0, 1440));
            var status = Statuses[rnd.Next(Statuses.Length)];
            object? shipped = status is "shipped" or "delivered" ? date.AddDays(rnd.Next(1, 6)).ToString("yyyy-MM-dd HH:mm:ss", inv) : null;
            object? note = rnd.Next(8) == 0 ? notes[rnd.Next(notes.Length)] : null;
            // Skewed customer distribution: some customers order much more often.
            var customer = 1 + (int)(Math.Pow(rnd.NextDouble(), 1.6) * CustomerCount);
            await Run(order, ct, i, Math.Min(customer, CustomerCount), date.ToString("yyyy-MM-dd", inv), status, shipped, note).ConfigureAwait(false);

            var lines = 1 + rnd.Next(5);
            var used = new HashSet<int>();
            for (var n = 1; n <= lines; n++)
            {
                int product;
                do product = 1 + rnd.Next(ProductCount); while (!used.Add(product));
                var discount = rnd.Next(6) == 0 ? 0.1 : 0.0;
                await Run(line, ct, i, n, product, 1 + (int)(Math.Pow(rnd.NextDouble(), 3) * 9), (double)prices[product - 1], discount).ConfigureAwait(false);
            }
        }
        await tx.CommitAsync(ct).ConfigureAwait(false);

        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "ANALYZE; VACUUM;";
            await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
    }

    private static string Ascii(string s)
    {
        var normalized = s.Normalize(System.Text.NormalizationForm.FormD);
        var sb = new System.Text.StringBuilder();
        foreach (var ch in normalized)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            if (char.IsAsciiLetterOrDigit(ch)) sb.Append(ch);
            else if (ch == 'ı') sb.Append('i');
        }
        return sb.ToString();
    }

    private static SqliteCommand Insert(SqliteConnection c, SqliteTransaction tx, string sql, params string[] names)
    {
        var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql;
        foreach (var n in names) cmd.Parameters.Add(new SqliteParameter { ParameterName = n });
        cmd.Prepare();
        return cmd;
    }

    private static Task<int> Run(SqliteCommand cmd, CancellationToken ct, params object?[] values)
    {
        for (var i = 0; i < values.Length; i++) cmd.Parameters[i].Value = values[i] ?? DBNull.Value;
        return cmd.ExecuteNonQueryAsync(ct);
    }
}
