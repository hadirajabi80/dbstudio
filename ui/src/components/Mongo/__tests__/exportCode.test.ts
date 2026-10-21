// Export to code in 5 languages (docs/PLAN-M2.md 6.4, QA "code export in 5 languages compiles/parses (snapshot)").
import { describe, expect, it } from 'vitest';
import { parseShell, parseShellArray } from '../../../mongo/shellJson';
import { CODE_LANGUAGES, exportCode, type ExportInput } from '../exportCode';

const PIPELINE = parseShellArray(`[
  { $match: { status: "paid", createdAt: { $gte: ISODate("2024-01-01T00:00:00Z") }, customer: ObjectId("66f1a2b3c4d5e6f708192a3b") } },
  { $unwind: "$items" },
  { $group: { _id: "$items.sku", qty: { $sum: "$items.qty" }, revenue: { $sum: NumberDecimal("0.0") }, n: { $sum: NumberLong(1) } } },
  { $match: { name: /^a/i, ratio: 5.0, tags: ["a", "b"], ok: true, nothing: null } },
  { $sort: { qty: -1 } },
  { $limit: 10 }
]`);

const AGG: ExportInput = { kind: 'aggregate', db: 'shop', coll: 'orders', pipeline: PIPELINE };
const FIND: ExportInput = {
  kind: 'find', db: 'shop', coll: 'orders', filter: parseShell('{ status: "paid", total: { $gt: 100 } }'),
  projection: parseShell('{ _id: 0, customer: 1 }'), sort: parseShell('{ createdAt: -1 }'), skip: 20, limit: 10,
};

describe('exportCode', () => {
  for (const { id } of CODE_LANGUAGES) {
    it(`aggregate → ${id}`, () => {
      expect(exportCode(id, AGG)).toMatchSnapshot();
    });
    it(`find → ${id}`, () => {
      expect(exportCode(id, FIND)).toMatchSnapshot();
    });
  }

  it('mongosh output parses back to the same pipeline', () => {
    const code = exportCode('shell', AGG);
    const inner = code.slice(code.indexOf('aggregate(') + 'aggregate('.length, code.lastIndexOf(')'));
    expect(parseShellArray(inner)).toEqual(PIPELINE);
  });

  it('uses each driver\'s types', () => {
    expect(exportCode('node', AGG)).toMatch(/import \{ MongoClient, Decimal128, Double, Long, ObjectId \} from 'mongodb';/);
    expect(exportCode('node', AGG)).toContain('new Double(5.0)');
    expect(exportCode('python', AGG)).toContain('datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)');
    expect(exportCode('python', AGG)).toContain("Regex('^a', 'i')");
    expect(exportCode('python', AGG)).toContain('True');
    expect(exportCode('csharp', AGG)).toContain('PipelineDefinition<BsonDocument, BsonDocument> pipeline');
    expect(exportCode('csharp', AGG)).toContain('ObjectId.Parse("66f1a2b3c4d5e6f708192a3b")');
    expect(exportCode('csharp', AGG)).toContain('1L');
    expect(exportCode('java', AGG)).toContain('import org.bson.types.Decimal128;');
    expect(exportCode('java', AGG)).toContain('new Document("$sort", new Document("qty", -1))');
  });

  it('can leave out the boilerplate', () => {
    const body = exportCode('node', FIND, { boilerplate: false });
    expect(body).not.toContain('MongoClient');
    expect(body).toContain('coll.find(filter, options)');
  });

  it('sorts in pymongo as a list of pairs', () => {
    expect(exportCode('python', FIND)).toContain("sort = [('createdAt', -1)]");
  });

  it('handles empty pipelines and filters', () => {
    expect(exportCode('shell', { kind: 'aggregate', db: 'd', coll: 'c', pipeline: [] })).toBe("db.getSiblingDB('d').getCollection('c').aggregate([]);");
    expect(exportCode('shell', { kind: 'find', db: 'd', coll: 'c', filter: parseShell('') })).toBe("db.getSiblingDB('d').getCollection('c').find({});");
  });

  it('writes binary, UUID, regex and timestamp values', () => {
    const v = parseShell('{ b: BinData(0, "AQID"), u: UUID("12345678-9012-3456-7890-123456789012"), t: Timestamp(1, 2), m: MinKey }');
    const input: ExportInput = { kind: 'find', db: 'd', coll: 'c', filter: v };
    expect(exportCode('node', input)).toContain("new Binary(Buffer.from('AQID', 'base64'), 0)");
    expect(exportCode('node', input)).toContain("new UUID('12345678-9012-3456-7890-123456789012')");
    expect(exportCode('java', input)).toContain('new BsonTimestamp(1, 2)');
    expect(exportCode('csharp', input)).toContain('BsonMinKey.Value');
    expect(exportCode('python', input)).toContain("UUID('12345678-9012-3456-7890-123456789012')");
  });
});
