// MongoDB "shop" seed (docs/PLAN-M2.md 6.5, package M2-M). Runs from /docker-entrypoint-initdb.d (compose service "mongo")
// or by hand: mongosh "mongodb://localhost:27018/?directConnection=true" engine/tests/docker/seed-mongo.js
// Deterministic (seeded PRNG) and idempotent (the database is dropped first).

db = db.getSiblingDB('shop');
db.dropDatabase();

// mulberry32: same data on every run.
let seed = 0x5eed2026;
function rand() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const hex = (n, width) => n.toString(16).padStart(width, '0');
const oid = (prefix, n) => ObjectId(prefix + hex(n, 24 - prefix.length));
const base = Date.UTC(2025, 0, 1);

// ---- customers (~200): nested address, tags array, mixed-type phone, tier
const first = ['Alice', 'Bob', 'Chloé', 'Dmitri', 'Elif', 'Farid', 'Grace', 'Hiro', 'Ines', 'Jonas', 'Kofi', 'Lena', 'Mateo', 'Nora', 'Omar', 'Priya'];
const last = ['Smith', 'Müller', 'Rossi', 'Kowalski', 'Yilmaz', 'Haddad', 'Tanaka', 'Silva', 'Novak', 'Okafor', 'Larsen', 'Dubois'];
const cities = [['Berlin', 'DE'], ['Paris', 'FR'], ['Milan', 'IT'], ['Tehran', 'IR'], ['Tokyo', 'JP'], ['Lisbon', 'PT'], ['Austin', 'US']];
const tagPool = ['vip', 'newsletter', 'b2b', 'early-adopter', 'returning', 'wholesale'];
const customers = [];
for (let i = 1; i <= 200; i++) {
  const [city, country] = pick(cities);
  const name = `${pick(first)} ${pick(last)}`;
  const c = {
    _id: oid('c0ffee', i),
    name,
    email: `customer${i}@example.com`,
    tier: pick(['bronze', 'silver', 'silver', 'gold', 'platinum']),
    address: { street: `${int(1, 250)} Main St`, city, country, zip: String(int(10000, 99999)) },
    tags: Array.from(new Set(Array.from({ length: int(0, 3) }, () => pick(tagPool)))),
    createdAt: new Date(base - int(0, 900) * 86400000),
  };
  // Mixed types on purpose (schema analysis): phone is a string or a number, sometimes missing.
  const r = rand();
  if (r < 0.6) c.phone = `+1-555-${hex(int(0, 65535), 4)}`;
  else if (r < 0.9) c.phone = NumberLong(5550000000 + i);
  if (i % 10 === 0) c.notes = null;
  customers.push(c);
}
db.customers.insertMany(customers);

// ---- products (~50): Decimal128 price, NumberLong stock, small Binary thumbnail, mixed rating
const kinds = ['Lamp', 'Desk', 'Chair', 'Shelf', 'Rug', 'Mirror', 'Sofa', 'Stool', 'Clock', 'Vase'];
const adjectives = ['Oak', 'Walnut', 'Steel', 'Linen', 'Glass'];
const products = [];
for (let i = 1; i <= 50; i++) {
  const kind = kinds[(i - 1) % kinds.length];
  const adj = adjectives[Math.floor((i - 1) / kinds.length)];
  const bytes = Array.from({ length: 16 }, () => int(0, 255));
  const rating = i % 5 === 0 ? 'unrated' : i % 2 === 0 ? int(1, 5) : Math.round((1 + rand() * 4) * 10) / 10;
  products.push({
    _id: oid('ab0de0', i),
    sku: `SKU-${String(i).padStart(4, '0')}`,
    name: `${adj} ${kind}`,
    description: `A ${adj.toLowerCase()} ${kind.toLowerCase()} for the living room, item ${i}.`,
    price: NumberDecimal((int(500, 50000) / 100).toFixed(2)),
    stock: NumberLong(int(0, 500)),
    thumbnail: BinData(0, Buffer.from(bytes).toString('base64')),
    rating,
  });
}
db.products.insertMany(products);

// ---- orders (~2,000): ObjectId refs, ISODate createdAt, status enum, items array, total double
const statuses = ['paid', 'paid', 'pending', 'shipped', 'shipped', 'cancelled'];
const orders = [];
for (let i = 1; i <= 2000; i++) {
  const n = int(1, 4);
  const items = [];
  let total = 0;
  for (let k = 0; k < n; k++) {
    const p = products[int(0, products.length - 1)];
    const qty = int(1, 5);
    const price = parseFloat(p.price.toString());
    items.push({ sku: p.sku, productId: p._id, qty, price });
    total += qty * price;
  }
  orders.push({
    _id: oid('0de2', i),
    customerId: customers[int(0, customers.length - 1)]._id,
    status: pick(statuses),
    createdAt: new Date(base + int(0, 365 * 24) * 3600000),
    items,
    total: Math.round(total * 100) / 100,
  });
}
db.orders.insertMany(orders);

// ---- sessions with a TTL index
const sessions = [];
for (let i = 1; i <= 50; i++) sessions.push({ _id: `sess-${i}`, customerId: customers[i]._id, lastSeen: new Date(base + i * 60000) });
db.sessions.insertMany(sessions);

// ---- indexes
db.orders.createIndex({ status: 1, createdAt: -1 });
db.orders.createIndex({ customerId: 1 });
db.customers.createIndex({ email: 1 }, { unique: true });
db.products.createIndex({ name: 'text', description: 'text' });
db.sessions.createIndex({ lastSeen: 1 }, { expireAfterSeconds: 3600 });

// ---- validation: $jsonSchema on customers (moderate / warn)
db.runCommand({
  collMod: 'customers',
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['name', 'email'],
      properties: {
        name: { bsonType: 'string' },
        email: { bsonType: 'string', pattern: '^.+@.+$' },
        tier: { enum: ['bronze', 'silver', 'gold', 'platinum'] },
        address: { bsonType: 'object', properties: { city: { bsonType: 'string' } } },
      },
    },
  },
  validationLevel: 'moderate',
  validationAction: 'warn',
});

// ---- a view
db.createView('paid_orders', 'orders', [
  { $match: { status: 'paid' } },
  { $project: { customerId: 1, total: 1, createdAt: 1 } },
]);

print(`shop seeded: ${db.customers.countDocuments()} customers, ${db.products.countDocuments()} products, ${db.orders.countDocuments()} orders`);
