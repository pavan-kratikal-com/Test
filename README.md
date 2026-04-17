# Threatcop ETDP — Scaffold (Node.js + MySQL)

Multi-engine, multi-tenant email threat detection platform. This repo is a
**scaffold only** — every engine is an Express stub that returns mock signals
so the pipeline shape is visible end-to-end. See `prd.md` for the full spec.

## Stack

- Node.js 20 + Express 4 (one process per engine)
- Zod for shared request/response schemas
- MySQL 8 for Stats DB / verdict store
- Redis 7 for caching
- Kafka (Bitnami image) for the deep-path queue
- Docker Compose orchestrates everything locally

## Layout

```
services/
  gateway/              # Entry point: orchestrates fast/deep paths
  e1_rspamd/            # Protocol/auth checks (stub)
  e2_slm/               # SLM classifier (stub)
  e3_stats_db/          # Per-org behavioral baselines
  e4_graph_db/          # Communication graph
  e5_url_scanner/       # URL/domain analysis
  e6_attachment/        # Static attachment analysis
  e7_visual/            # Brand/credential-form detection
  e8_sandbox/           # Dynamic execution (stub; cloud only)
  e9_specialized_ml/    # Homoglyph/header/encoding/structure ML
  synthesizer/          # Reasoning model that aggregates signals
shared/
  schemas.js            # Zod models for Email, Signal, Verdict
  engineBase.js         # Express factory every engine reuses
db/
  migrations/0001_stats_db.sql  (MySQL 8)
infra/
  docker-compose.yml    # MySQL + Redis + Kafka + all services
examples/
  sample_email.json
```

## Quickstart

```bash
docker compose -f infra/docker-compose.yml up --build
curl -X POST http://localhost:8000/v1/analyze \
  -H 'content-type: application/json' \
  -d @examples/sample_email.json
```

## APIs (gateway, port 8000)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/analyze` | Run email through fast + deep path, persist verdict |
| POST | `/v1/feedback` | Submit user/SOC label (spam/ham/phishing/release/confirm_block) |
| GET  | `/v1/verdicts?org_id=&label=&since=&limit=` | Verdict history |
| GET  | `/v1/stats?org_id=` | Label × verdict breakdown |
| GET  | `/health` | Liveness |

## Status

Phase 1 in progress. What's real vs stubbed:

| Component | State |
|---|---|
| Gateway fast/deep path orchestration | real |
| Verdict persistence (MySQL) | real |
| Feedback + history APIs | real |
| **E3 Stats DB** — 5 of 36 signals | real (first_time_sender, first_time_pair, domain_first_seen[_recent], off_hours_email, sender_burst) |
| E1 rspamd, E2 SLM, E4–E9, synthesizer | stubs — mock signals only |
| Async deep-path queue (Kafka) | declared in compose, not wired |
| Per-org fine-tuning | not started (Phase 2) |

See `prd.md` §14 for the phased roadmap.
