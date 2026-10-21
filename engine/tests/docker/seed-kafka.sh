#!/usr/bin/env bash
# Seeds the compose Kafka + Schema Registry (profile "kafka") for the M2-K walkthrough (docs/qa/kafka-walkthrough.md):
#   topics  orders (3 partitions, 120 JSON messages with headers), payments-avro (Avro via the registry),
#           events-proto (Protobuf via the registry), compacted-users (cleanup.policy=compact)
#   groups  billing (Empty, committed behind the end: lag), shipping (offsets at the end)
# Usage: bash engine/tests/docker/seed-kafka.sh   (after: docker compose -f engine/tests/docker/compose.yml --profile kafka up -d)
set -euo pipefail
cd "$(dirname "$0")"
DC=(docker compose -f compose.yml --profile kafka)
BIN=/opt/kafka/bin
BS=localhost:9092
SR=${SCHEMA_REGISTRY_URL:-http://localhost:${SCHEMA_REGISTRY_PORT:-18081}}

k() { "${DC[@]}" exec -T kafka "$@"; }

echo "== topics"
for spec in "orders:3" "payments-avro:2" "events-proto:1" "compacted-users:1"; do
  name=${spec%%:*}; parts=${spec##*:}
  k $BIN/kafka-topics.sh --bootstrap-server $BS --create --if-not-exists --topic "$name" --partitions "$parts" --replication-factor 1 >/dev/null
done
k $BIN/kafka-configs.sh --bootstrap-server $BS --alter --entity-type topics --entity-name compacted-users \
  --add-config cleanup.policy=compact,retention.ms=3600000 >/dev/null

echo "== orders: 120 JSON messages with keys and headers"
{
  for i in $(seq 1 120); do
    printf 'traceparent:00-%032x-01,source:seed\tcust-%d\t{"id":%d,"customer":"cust-%d","total":%d.5,"note":"%s"}\n' \
      "$i" $((i % 7)) "$i" $((i % 7)) $((i * 3)) "$([ $((i % 10)) -eq 0 ] && echo rush || echo normal)"
  done
} | k $BIN/kafka-console-producer.sh --bootstrap-server $BS --topic orders \
      --property parse.key=true --property key.separator=$'\t' --property parse.headers=true --property headers.delimiter=$'\t' \
      --property headers.separator=, --property headers.key.separator=:

echo "== schema registry subjects"
AVRO='{"type":"record","name":"Payment","namespace":"shop","fields":[{"name":"id","type":"long"},{"name":"amount","type":"double"},{"name":"currency","type":{"type":"enum","name":"Currency","symbols":["EUR","USD"]}},{"name":"note","type":["null","string"],"default":null}]}'
PROTO='syntax = "proto3"; package shop; message Event { string name = 1; int64 at = 2; map<string, string> attrs = 3; }'
curl -fsS -X POST -H 'Content-Type: application/vnd.schemaregistry.v1+json' "$SR/subjects/payments-avro-value/versions" \
  --data "$(printf '{"schema":%s}' "$(printf '%s' "$AVRO" | sed 's/"/\\"/g; s/^/"/; s/$/"/')")" ; echo
curl -fsS -X POST -H 'Content-Type: application/vnd.schemaregistry.v1+json' "$SR/subjects/events-proto-value/versions" \
  --data "$(printf '{"schemaType":"PROTOBUF","schema":%s}' "$(printf '%s' "$PROTO" | sed 's/"/\\"/g; s/^/"/; s/$/"/')")" ; echo
echo "   Produce Avro/Protobuf messages from DbStudio (Produce… → value format avro / protobuf, subject *-value)."

echo "== consumer groups"
k $BIN/kafka-consumer-groups.sh --bootstrap-server $BS --group billing --topic orders --reset-offsets --to-offset 10 --execute >/dev/null
k $BIN/kafka-consumer-groups.sh --bootstrap-server $BS --group shipping --topic orders --reset-offsets --to-latest --execute >/dev/null
k $BIN/kafka-consumer-groups.sh --bootstrap-server $BS --describe --all-groups || true
echo "Seeded. Connect DbStudio to localhost:${KAFKA_PORT:-19092} (PLAINTEXT), Schema Registry $SR."
