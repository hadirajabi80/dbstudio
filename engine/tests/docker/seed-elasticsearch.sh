#!/bin/sh
# Elasticsearch seed (plan-batch3 WP-ES), run by the one-shot elasticsearch-seed service (curlimages/curl).
# Bulk-loads seed-elasticsearch.ndjson into $ES_URL. WP0 placeholder: WP-ES adds index mappings and data.
set -eu
ES_URL="${ES_URL:-http://localhost:19200}"
if [ -s /seed/seed-elasticsearch.ndjson ]; then
  curl -fsS -H 'Content-Type: application/x-ndjson' -X POST "$ES_URL/_bulk?refresh=true" --data-binary @/seed/seed-elasticsearch.ndjson > /dev/null
fi
echo "elasticsearch seed done"
