#!/bin/sh
# Redis seed (docs/PLAN-M2.md 5.6), run by the one-shot redis-seed service with REDIS_HOST=redis.
# Writes a small, varied keyspace into db 0 (every type incl. a stream with a consumer group and RedisJSON),
# plus 10,000 namespaced keys for the browser / analysis walkthrough (docs/qa/redis-walkthrough.md).
set -e
R="redis-cli -h ${REDIS_HOST:-localhost} -p ${REDIS_PORT:-6379}"
$R PING
$R FLUSHDB
$R SET greeting "hello world"
$R SET config:json '{"feature":{"darkMode":true,"beta":["search","export"]},"version":3}'
$R SET session:abc123 '{"user":1001}' EX 3600
$R HSET user:1001:profile name Alice email alice@example.com tier gold
$R HSET user:1002:profile name Bob email bob@example.com tier silver
$R RPUSH queue:jobs job:1 job:2 job:3 job:4
$R SADD tags red green blue
$R ZADD leaderboard 3200 alice 2900 bob 4100 carol 1500 dave
$R XADD events '*' type login user 1001
$R XADD events '*' type purchase user 1001 amount 19.99
$R XADD events '*' type logout user 1001
$R XGROUP CREATE events analytics 0
$R XREADGROUP GROUP analytics worker-1 COUNT 2 STREAMS events '>'
$R JSON.SET doc:product:1 '$' '{"name":"Widget","price":9.5,"tags":["a","b"],"stock":{"eu":12,"us":4}}' || echo "RedisJSON not loaded"
# bulk keys: user:<n>:cart lists, cache:<n> strings with TTLs, metrics:<n> hashes
i=0
while [ $i -lt 2000 ]; do
  printf 'SET cache:%s value-%s EX %s\r\nRPUSH user:%s:cart item-1 item-2\r\nHSET metrics:%s hits %s misses %s\r\nSADD idx:%s a b\r\nSET plain:%s x\r\n' \
    $i $i $((60 + i)) $i $i $i $((i % 7)) $((i % 50)) $i
  i=$((i + 1))
done | $R --pipe
$R DBSIZE
