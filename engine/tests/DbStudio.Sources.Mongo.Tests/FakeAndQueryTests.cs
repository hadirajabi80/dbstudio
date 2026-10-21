using DbStudio.Sources.Mongo.Tests.Fake;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Tests;

public sealed class FakeFilterTests
{
    private static readonly BsonDocument Doc = ShellJson.ParseDocument("""
        { _id: 1, name: "Alice", age: 34, score: 9.5, tags: ["a", "b"], nil: null,
          address: { city: "Paris", geo: { lat: 48.8 } },
          items: [ { sku: "X", qty: 2 }, { sku: "Y", qty: 5 } ], at: ISODate("2024-05-01") }
        """, "doc");

    private static bool M(string filter) => FakeQuery.Matches(Doc, ShellJson.ParseDocument(filter, "filter"));

    [Theory]
    [InlineData("{}", true)]
    [InlineData("{ name: 'Alice' }", true)]
    [InlineData("{ name: { $eq: 'Bob' } }", false)]
    [InlineData("{ name: { $ne: 'Bob' } }", true)]
    [InlineData("{ age: { $gt: 30, $lte: 34 } }", true)]
    [InlineData("{ age: { $lt: 30 } }", false)]
    [InlineData("{ age: { $gte: 34.0 } }", true)]
    [InlineData("{ age: NumberLong(34) }", true)]
    [InlineData("{ age: { $gt: '1' } }", false)]
    [InlineData("{ name: { $in: ['Bob', 'Alice'] } }", true)]
    [InlineData("{ name: { $nin: ['Bob', 'Alice'] } }", false)]
    [InlineData("{ name: /^al/i }", true)]
    [InlineData("{ name: { $regex: '^AL', $options: 'i' } }", true)]
    [InlineData("{ name: { $in: [/^B/, /ice$/] } }", true)]
    [InlineData("{ missing: { $exists: false } }", true)]
    [InlineData("{ nil: { $exists: true } }", true)]
    [InlineData("{ nil: null }", true)]
    [InlineData("{ missing: null }", true)]
    [InlineData("{ name: null }", false)]
    [InlineData("{ score: { $type: 'double' } }", true)]
    [InlineData("{ age: { $type: 'number' } }", true)]
    [InlineData("{ age: { $type: 16 } }", true)]
    [InlineData("{ tags: { $type: 'array' } }", true)]
    [InlineData("{ tags: { $size: 2 } }", true)]
    [InlineData("{ tags: 'b' }", true)]
    [InlineData("{ tags: ['a', 'b'] }", true)]
    [InlineData("{ tags: { $all: ['b', 'a'] } }", true)]
    [InlineData("{ tags: { $all: ['b', 'c'] } }", false)]
    [InlineData("{ 'address.city': 'Paris' }", true)]
    [InlineData("{ 'address.geo.lat': { $gt: 48 } }", true)]
    [InlineData("{ 'items.sku': 'Y' }", true)]
    [InlineData("{ 'items.1.qty': 5 }", true)]
    [InlineData("{ items: { $elemMatch: { sku: 'X', qty: { $gt: 3 } } } }", false)]
    [InlineData("{ items: { $elemMatch: { sku: 'Y', qty: { $gt: 3 } } } }", true)]
    [InlineData("{ $or: [{ age: 1 }, { name: 'Alice' }] }", true)]
    [InlineData("{ $and: [{ age: 34 }, { name: 'Bob' }] }", false)]
    [InlineData("{ $nor: [{ age: 1 }, { name: 'Bob' }] }", true)]
    [InlineData("{ age: { $not: { $gt: 40 } } }", true)]
    [InlineData("{ name: { $not: /^A/ } }", false)]
    [InlineData("{ at: { $gte: ISODate('2024-01-01') } }", true)]
    [InlineData("{ age: { $mod: [10, 4] } }", true)]
    [InlineData("{ $expr: { $gt: ['$age', 30] } }", true)]
    public void Filters(string filter, bool expected) => Assert.Equal(expected, M(filter));

    [Fact]
    public void Unknown_operators_are_server_errors()
    {
        var ex = Assert.Throws<MongoDB.Driver.MongoCommandException>(() => M("{ a: { $foo: 1 } }"));
        Assert.Equal(2, ex.Code);
    }

    [Fact]
    public void Projection_inclusion_exclusion_and_errors()
    {
        var inc = FakeQuery.Project(Doc, ShellJson.ParseDocument("{ name: 1, 'address.city': 1, 'items.sku': 1 }", "p"));
        Assert.Equal(["_id", "name", "address", "items"], inc.Names);
        Assert.Equal(new BsonDocument("city", "Paris"), inc["address"]);
        Assert.Equal(new BsonArray { new BsonDocument("sku", "X"), new BsonDocument("sku", "Y") }, inc["items"]);
        var exc = FakeQuery.Project(Doc, ShellJson.ParseDocument("{ _id: 0, items: 0 }", "p"));
        Assert.False(exc.Contains("_id"));
        Assert.False(exc.Contains("items"));
        Assert.True(exc.Contains("tags"));
        Assert.Throws<MongoDB.Driver.MongoCommandException>(() => FakeQuery.Project(Doc, ShellJson.ParseDocument("{ a: 1, b: 0 }", "p")));
        var computed = FakeQuery.Project(Doc, ShellJson.ParseDocument("{ _id: 0, who: '$name' }", "p"));
        Assert.Equal(new BsonDocument("who", "Alice"), computed);
    }

    [Fact]
    public void Sort_is_type_aware_and_multi_key()
    {
        var docs = new[]
        {
            new BsonDocument { { "_id", 1 }, { "v", "b" } }, new BsonDocument { { "_id", 2 }, { "v", 3 } },
            new BsonDocument { { "_id", 3 }, { "v", 1.5 } }, new BsonDocument("_id", 4), new BsonDocument { { "_id", 5 }, { "v", "a" } },
        };
        Assert.Equal([4, 3, 2, 5, 1], FakeQuery.Sort(docs, new BsonDocument("v", 1)).Select(d => d["_id"].AsInt32));
        Assert.Equal([1, 5, 2, 3, 4], FakeQuery.Sort(docs, new BsonDocument("v", -1)).Select(d => d["_id"].AsInt32));
    }

    [Fact]
    public async Task Pipeline_stages()
    {
        var fake = T.Shop();
        var rows = await fake.AggregateAsync("shop", "orders",
        [
            T.Doc("""{ "$match": { "status": { "$in": ["paid", "shipped"] } } }"""),
            T.Doc("""{ "$unwind": "$items" }"""),
            T.Doc("""{ "$group": { "_id": "$status", "n": { "$sum": 1 }, "qty": { "$sum": "$items.qty" }, "avg": { "$avg": "$total" }, "max": { "$max": "$total" }, "skus": { "$addToSet": "$items.sku" } } }"""),
            T.Doc("""{ "$sort": { "_id": 1 } }"""),
            T.Doc("""{ "$addFields": { "label": { "$concat": ["s:", "$_id"] } } }"""),
            T.Doc("""{ "$project": { "_id": 1, "n": 1, "label": 1, "skuCount": { "$size": "$skus" }, "max": 1 } }"""),
        ], new AggregateSpec(), CancellationToken.None);
        Assert.Equal(2, rows.Count);
        Assert.Equal("paid", rows[0]["_id"].AsString);
        Assert.Equal(25, rows[0]["n"].AsInt32);
        Assert.Equal("s:paid", rows[0]["label"].AsString);
        Assert.Equal(5, rows[0]["skuCount"].AsInt32);
        Assert.Equal(1050.0, rows[0]["max"].AsDouble);
        Assert.Equal(1029.0, rows[1]["max"].AsDouble);

        var counted = await fake.AggregateAsync("shop", "orders", [T.Doc("""{ "$sortByCount": "$status" }""")], new AggregateSpec(), CancellationToken.None);
        Assert.Equal(4, counted.Count);
        Assert.All(counted, r => Assert.Equal(25, r["count"].AsInt32));
        var total = await fake.AggregateAsync("shop", "orders",
            [T.Doc("""{ "$group": { "_id": null, "s": { "$sum": "$total" }, "first": { "$first": "$status" } } }"""), T.Doc("""{ "$replaceRoot": { "newRoot": { "total": "$s" } } }""")],
            new AggregateSpec(), CancellationToken.None);
        Assert.Equal(53025.0, Assert.Single(total)["total"].AsDouble);
        var count = await fake.AggregateAsync("shop", "customers", [T.Doc("""{ "$match": { "tier": "gold" } }"""), T.Doc("""{ "$count": "n" }""")],
            new AggregateSpec(), CancellationToken.None);
        Assert.Equal(6, Assert.Single(count)["n"].AsInt32);
        var view = await fake.FindAsync("shop", "paid_orders", new FindSpec([]), CancellationToken.None);
        Assert.Equal(25, view.Count);
    }

    [Fact]
    public async Task Unique_indexes_reject_duplicates_on_insert()
    {
        var fake = T.Shop();
        var r = await fake.InsertManyAsync("shop", "customers",
            [T.Doc("""{ "_id": 100, "email": "new@example.com" }"""), T.Doc("""{ "_id": 101, "email": "c1@example.com" }"""), T.Doc("""{ "_id": 1 }""")],
            ordered: false, CancellationToken.None);
        Assert.Equal(1, r.Inserted);
        Assert.Equal([1, 2], r.Errors.Select(e => e.Index));
        Assert.All(r.Errors, e => Assert.Equal(11000, e.Code));
        Assert.Contains("email_1", r.Errors[0].Message);
    }
}
