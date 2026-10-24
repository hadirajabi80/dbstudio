#!/bin/sh
# Elasticsearch / OpenSearch "shop" seed (plan-batch3 WP-ES), run by the one-shot elasticsearch-seed service
# (curlimages/curl) or by hand: ES_URL=http://localhost:19200 sh engine/tests/docker/seed-elasticsearch.sh
# Idempotent: drops shop-customers, shop-products, shop-orders, creates them with explicit mappings (the put_index
# blocks below; the engine's live tests read the same blocks), bulk-loads seed-elasticsearch.ndjson (the seed-mongo.js
# data: 200 customers incl. Persian names, 50 products, 2,000 orders) and adds the alias shop-sales -> shop-orders.
set -eu
ES_URL="${ES_URL:-http://localhost:19200}"
DIR="${SEED_DIR:-/seed}"
[ -f "$DIR/seed-elasticsearch.ndjson" ] || DIR="$(dirname "$0")"

for index in shop-customers shop-products shop-orders; do
  curl -sS -o /dev/null -X DELETE "$ES_URL/$index" || true
done

put_index() {
  curl -fsS -o /dev/null -H 'Content-Type: application/json' -X PUT "$ES_URL/$1" --data-binary @-
}

put_index shop-customers <<'JSON'
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "properties": {
      "name": { "type": "text", "fields": { "keyword": { "type": "keyword", "ignore_above": 256 } } },
      "email": { "type": "keyword" },
      "tier": { "type": "keyword" },
      "address": {
        "properties": {
          "street": { "type": "text" },
          "city": { "type": "keyword" },
          "country": { "type": "keyword" },
          "zip": { "type": "keyword" }
        }
      },
      "tags": { "type": "keyword" },
      "phone": { "type": "keyword" },
      "createdAt": { "type": "date" },
      "notes": { "type": "text" }
    }
  }
}
JSON

put_index shop-products <<'JSON'
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "properties": {
      "sku": { "type": "keyword" },
      "name": { "type": "text", "fields": { "keyword": { "type": "keyword", "ignore_above": 256 } } },
      "description": { "type": "text" },
      "price": { "type": "double" },
      "stock": { "type": "long" },
      "rating": { "type": "float" },
      "ratingLabel": { "type": "keyword" },
      "thumbnail": { "type": "binary" }
    }
  }
}
JSON

put_index shop-orders <<'JSON'
{
  "settings": { "number_of_shards": 2, "number_of_replicas": 0 },
  "mappings": {
    "properties": {
      "customerId": { "type": "keyword" },
      "status": { "type": "keyword" },
      "createdAt": { "type": "date" },
      "items": {
        "type": "nested",
        "properties": {
          "sku": { "type": "keyword" },
          "productId": { "type": "keyword" },
          "qty": { "type": "integer" },
          "price": { "type": "double" }
        }
      },
      "total": { "type": "double" }
    }
  },
  "aliases": { "shop-sales": {} }
}
JSON

curl -fsS -o /dev/null -H 'Content-Type: application/x-ndjson' -X POST "$ES_URL/_bulk?refresh=true" \
  --data-binary @"$DIR/seed-elasticsearch.ndjson"
echo "elasticsearch seed done"
