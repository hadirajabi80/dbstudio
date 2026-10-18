#!/bin/sh
# Redis seed (docs/PLAN-M2.md 5.6), run by the one-shot redis-seed service with REDIS_HOST=redis.
# M2-0 placeholder so the compose mount exists; M2-R replaces it.
redis-cli -h "${REDIS_HOST:-localhost}" PING
