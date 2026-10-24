// Sample data of the Elasticsearch mock (dev:mock and the MSW tests): the seed-mongo.js / seed-elasticsearch.ndjson
// "shop" data from the same mulberry32 sequence (200 customers incl. the Persian names, 50 products, 2,000 orders),
// the mappings of engine/tests/docker/seed-elasticsearch.sh, plus a small `logs-app-default` data stream, a hidden
// system index and some templates. Only imported by mocks/packs/elasticsearch.ts.

export type Source = Record<string, unknown>;

export interface SeedIndex {
  name: string;
  mappings: Source;
  shards: number;
  replicas: number;
  aliases: string[];
  hidden?: boolean;
  dataStream?: string;
  docs: { id: string; source: Source }[];
}

const BASE = Date.UTC(2025, 0, 1);

export function shopData(): { customers: { id: string; source: Source }[]; products: { id: string; source: Source }[]; orders: { id: string; source: Source }[] } {
  let seed = 0x5eed2026;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
  const oid = (prefix: string, n: number) => prefix + hex(n, 24 - prefix.length);
  const iso = (ms: number) => new Date(ms).toISOString();

  const first = ['Alice', 'Bob', 'Chloé', 'Dmitri', 'Elif', 'Farid', 'Grace', 'Hiro', 'Ines', 'Jonas', 'Kofi', 'Lena', 'Mateo', 'Nora', 'Omar', 'Priya'];
  const last = ['Smith', 'Müller', 'Rossi', 'Kowalski', 'Yilmaz', 'Haddad', 'Tanaka', 'Silva', 'Novak', 'Okafor', 'Larsen', 'Dubois'];
  const cities = [['Berlin', 'DE'], ['Paris', 'FR'], ['Milan', 'IT'], ['Tehran', 'IR'], ['Tokyo', 'JP'], ['Lisbon', 'PT'], ['Austin', 'US']];
  const tagPool = ['vip', 'newsletter', 'b2b', 'early-adopter', 'returning', 'wholesale'];
  const customers: { id: string; source: Source }[] = [];
  for (let i = 1; i <= 200; i++) {
    const [city, country] = pick(cities);
    const name = `${pick(first)} ${pick(last)}`;
    const c: Source = {
      name,
      email: `customer${i}@example.com`,
      tier: pick(['bronze', 'silver', 'silver', 'gold', 'platinum']),
      address: { street: `${int(1, 250)} Main St`, city, country, zip: String(int(10000, 99999)) },
      tags: Array.from(new Set(Array.from({ length: int(0, 3) }, () => pick(tagPool)))),
      createdAt: iso(BASE - int(0, 900) * 86400000),
    };
    const r = rand();
    if (r < 0.6) c.phone = `+1-555-${hex(int(0, 65535), 4)}`;
    else if (r < 0.9) c.phone = String(5550000000 + i);
    if (i % 10 === 0) c.notes = null;
    customers.push({ id: oid('c0ffee', i), source: c });
  }
  customers[1].source.name = 'علی رضایی';
  customers[2].source.name = 'مریم احمدی';
  customers[3].source.name = 'محمد عبدالله';
  customers[4].source.name = 'Sara سارا کریمی';
  customers[2].source.notes = 'Order #12 سفارش';
  customers[3].source.notes = '12 سفارش در انتظار ارسال';

  const kinds = ['Lamp', 'Desk', 'Chair', 'Shelf', 'Rug', 'Mirror', 'Sofa', 'Stool', 'Clock', 'Vase'];
  const adjectives = ['Oak', 'Walnut', 'Steel', 'Linen', 'Glass'];
  const products: { id: string; source: Source }[] = [];
  for (let i = 1; i <= 50; i++) {
    const kind = kinds[(i - 1) % kinds.length];
    const adj = adjectives[Math.floor((i - 1) / kinds.length)];
    const bytes = Array.from({ length: 16 }, () => int(0, 255));
    const rating = i % 5 === 0 ? 'unrated' : i % 2 === 0 ? int(1, 5) : Math.round((1 + rand() * 4) * 10) / 10;
    const p: Source = {
      sku: `SKU-${String(i).padStart(4, '0')}`,
      name: `${adj} ${kind}`,
      description: `A ${adj.toLowerCase()} ${kind.toLowerCase()} for the living room, item ${i}.`,
      price: Number((int(500, 50000) / 100).toFixed(2)),
      stock: int(0, 500),
      thumbnail: btoa(String.fromCharCode(...bytes)),
    };
    if (typeof rating === 'number') p.rating = rating;
    p.ratingLabel = String(rating);
    products.push({ id: oid('ab0de0', i), source: p });
  }

  const statuses = ['paid', 'paid', 'pending', 'shipped', 'shipped', 'cancelled'];
  const orders: { id: string; source: Source }[] = [];
  for (let i = 1; i <= 2000; i++) {
    const n = int(1, 4);
    const items: Source[] = [];
    let total = 0;
    for (let k = 0; k < n; k++) {
      const p = products[int(0, products.length - 1)];
      const qty = int(1, 5);
      const price = p.source.price as number;
      items.push({ sku: p.source.sku, productId: p.id, qty, price });
      total += qty * price;
    }
    orders.push({
      id: oid('0de2', i),
      source: { customerId: customers[int(0, customers.length - 1)].id, status: pick(statuses), createdAt: iso(BASE + int(0, 365 * 24) * 3600000), items, total: Math.round(total * 100) / 100 },
    });
  }
  return { customers, products, orders };
}

const KW = { type: 'keyword' };
const TEXT_KW = { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } };

export const SHOP_MAPPINGS: Record<string, Source> = {
  'shop-customers': {
    properties: {
      name: TEXT_KW, email: KW, tier: KW,
      address: { properties: { street: { type: 'text' }, city: KW, country: KW, zip: KW } },
      tags: KW, phone: KW, createdAt: { type: 'date' }, notes: { type: 'text' },
    },
  },
  'shop-products': {
    properties: {
      sku: KW, name: TEXT_KW, description: { type: 'text' }, price: { type: 'double' }, stock: { type: 'long' },
      rating: { type: 'float' }, ratingLabel: KW, thumbnail: { type: 'binary' },
    },
  },
  'shop-orders': {
    properties: {
      customerId: KW, status: KW, createdAt: { type: 'date' },
      items: { type: 'nested', properties: { sku: KW, productId: KW, qty: { type: 'integer' }, price: { type: 'double' } } },
      total: { type: 'double' },
    },
  },
};

export function seedIndices(): SeedIndex[] {
  const { customers, products, orders } = shopData();
  const levels = ['INFO', 'INFO', 'INFO', 'WARN', 'ERROR', 'DEBUG'];
  const services = ['checkout', 'catalog', 'auth', 'search'];
  const messages = ['order placed', 'payment authorised', 'cache miss for product', 'login ok', 'login failed: bad password', 'slow query 1.2s', 'search took 34 ms'];
  const logs = Array.from({ length: 300 }, (_, i) => ({
    id: `log-${String(i + 1).padStart(4, '0')}`,
    source: {
      '@timestamp': new Date(Date.UTC(2026, 9, 14, 8, 0, 0) + i * 61_000).toISOString(),
      level: levels[(i * 7) % levels.length], service: services[(i * 3) % services.length], message: messages[(i * 5) % messages.length],
      http: { status: [200, 200, 201, 404, 500][(i * 11) % 5], duration_ms: 5 + ((i * 37) % 900) },
    },
  }));
  return [
    { name: 'shop-customers', mappings: SHOP_MAPPINGS['shop-customers'], shards: 1, replicas: 0, aliases: [], docs: customers },
    { name: 'shop-products', mappings: SHOP_MAPPINGS['shop-products'], shards: 1, replicas: 0, aliases: [], docs: products },
    { name: 'shop-orders', mappings: SHOP_MAPPINGS['shop-orders'], shards: 2, replicas: 0, aliases: ['shop-sales'], docs: orders },
    {
      name: '.ds-logs-app-default-2026.10.14-000001', hidden: true, dataStream: 'logs-app-default', shards: 1, replicas: 0, aliases: [],
      mappings: {
        properties: {
          '@timestamp': { type: 'date' }, level: KW, service: KW, message: { type: 'text' },
          http: { properties: { status: { type: 'integer' }, duration_ms: { type: 'long' } } },
        },
      },
      docs: logs,
    },
    { name: '.rowlit-system', hidden: true, shards: 1, replicas: 0, aliases: [], mappings: { properties: { key: KW } }, docs: [{ id: 'state', source: { key: 'mock' } }] },
  ];
}

export const MOCK_TEMPLATES = [
  {
    name: 'logs-app', kind: 'index' as const, patterns: ['logs-app-*'], priority: 200, version: 3, dataStream: true, composedOf: ['logs-mappings'],
    body: { index_patterns: ['logs-app-*'], data_stream: {}, priority: 200, composed_of: ['logs-mappings'], template: { settings: { number_of_replicas: 0 } } },
  },
  {
    name: 'logs-mappings', kind: 'component' as const, patterns: [], priority: null, version: 1, dataStream: false, composedOf: [],
    body: { template: { mappings: { properties: { '@timestamp': { type: 'date' }, message: { type: 'text' }, level: { type: 'keyword' } } } } },
  },
  {
    name: 'shop-template', kind: 'legacy' as const, patterns: ['shop-*'], priority: 0, version: null, dataStream: false, composedOf: [],
    body: { order: 0, index_patterns: ['shop-*'], settings: { index: { number_of_replicas: '0' } }, mappings: {}, aliases: {} },
  },
];
