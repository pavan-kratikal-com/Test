#!/usr/bin/env bash
# Smoke test: assumes `docker compose -f infra/docker-compose.yml up` is running.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> gateway /health"
curl -fsS http://localhost:8000/health
echo

echo "==> POST /v1/analyze"
curl -fsS -X POST http://localhost:8000/v1/analyze \
  -H 'content-type: application/json' \
  --data-binary @"$HERE/sample_email.json" | python3 -m json.tool
