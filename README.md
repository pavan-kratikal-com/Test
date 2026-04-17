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
| POST | `/v1/feedback` | Submit label (spam/ham/phishing/release/confirm_block) |
| GET  | `/v1/verdicts?org_id=&label=&since=&limit=` | Verdict history |
| GET  | `/v1/stats?org_id=` | Label × verdict breakdown |
| POST | `/v1/orgs` | Register an org (industry, timezone, thresholds) |
| GET  | `/v1/orgs/:id` | Fetch org config |
| PUT  | `/v1/orgs/:id/thresholds` | Update block/quarantine thresholds |
| GET  | `/health` | Liveness |

## Evaluation

```
node tools/evaluate.js examples/labeled_emails.jsonl
```

Prints per-label precision/recall/F1, confusion matrix, and FP rate. Exits
non-zero if FP rate exceeds 0.5% (PRD Phase 1 target).

## Unit tests

```
npm test
```

Runs 70+ unit tests (Node's native `node:test`) covering shared schemas,
gateway aggregation + industry weights, and every engine's pure analyze
logic. No MySQL or Redis required — the tests set `ETDP_NO_LISTEN=1` so
engine modules can be imported without starting an HTTP listener.

## Status

**Phase 1 complete + hardened.** What's real vs stubbed:

| Component | State |
|---|---|
| Gateway fast/deep path orchestration | real |
| **Staged fanout** (E1 → E2 with prior_signals) | real |
| **Per-org registry** with industry priors + thresholds | real |
| **Cold-start ramp** (Stats DB signals scale 0→1 over 30 days) | real |
| **E3 Stats DB** — 25 of 36 signals | real; 11 stubbed with `DATA_DEP` tags |
| Verdict persistence + feedback + history APIs | real |
| Redis cache (Stats DB hot lookups) | real (no-op fallback) |
| Evaluation framework | real |
| **Schema-per-tenant MySQL isolation** | real — `etdp_shared` + `etdp_org_<id>` |
| **Kafka-backed async deep path** | real (Kafka up) / sync-fallback (Kafka down) |
| **Real rspamd integration** (E1 HTTP translator) | real (RSPAMD_URL set) / fallback grep |
| E2 SLM, E4–E9, synthesizer detection logic | stubs — mock signals only |
| Per-org ML fine-tuning | Phase 2 |

See `prd.md` §14 for the phased roadmap.
