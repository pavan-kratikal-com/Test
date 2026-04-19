# ETDP Signal Reference

Complete inventory of every signal across all engines — built, stubbed, unmapped,
and proposed. This is the single source of truth for what the platform measures,
what feeds the per-org model, and what's planned.

Last updated: 2026-04-19

---

## Architecture Overview

```
Email → Gateway (orchestrator)
         ├── E1 Rspamd        (authentication)
         ├── E2 SLM           (content/language analysis)
         ├── E3 Stats DB      (behavioral baselines)
         ├── E4 Graph DB      (relationship & trust)
         ├── E5 URL Scanner   (URL/domain analysis)
         ├── E6 Attachment    (file analysis)
         ├── E7 Visual        (landing page analysis)
         ├── E8 Sandbox       (dynamic execution)
         └── E9 Specialized ML (header/encoding/structure)
                    ↓
         Signal list → Feature vector (FEATURE_NAMES) → Per-org LR model → Verdict
```

Each engine returns `{ engine, signal, score, detail }` objects. The gateway
collects all signals, `signalsToFeatures()` maps them to a fixed-length binary
feature vector, and the per-org logistic regression model produces the verdict.

**Signal → Feature mapping**: A signal fires in an engine but only affects the
model if it has a matching entry in `FEATURE_NAMES` (shared/features.js) and a
regex pattern in `PATTERNS`. Signals without a feature mapping are persisted in
the verdict detail but invisible to the model.

---

## Summary

| Engine | Built | Unmapped | Stubbed (DATA_DEP) | Proposed | Total |
|--------|------:|--------:|---------:|--------:|------:|
| E1 Rspamd | 3 fixed + dynamic | 0 | 0 | 0 | 3+ |
| E2 SLM | 7 | 0 | 0 | 8 | 15 |
| E3 Stats DB | 34 | 11 | 3 | 9 | 46 |
| E4 Graph DB | 18 | 9 | 8 | 7 | 33 |
| E5 URL Scanner | 19 | 8 | 0 | 3 | 22 |
| E6 Attachment | 1 | 0 | 0 | 5 | 6 |
| E7 Visual | 1 | 0 | 0 | 3 | 4 |
| E8 Sandbox | 0 | 0 | 0 | 0 | 0 |
| E9 Specialized ML | 13 | 1 | 0 | 3 | 16 |
| **TOTAL** | **96+** | **19** | **11** | **38** | **145+** |

Feature vector slots: **46 current** → **84 after proposed additions**

---

## E1 Rspamd — Email Authentication

**Engine field:** `"rspamd"`
**Service:** `services/e1_rspamd/index.js`
**Type:** Authentication (not behavioral — keep as-is)

### Fixed signals (fallback/header-grep mode)

| # | Signal | Score | Feature | Notes |
|---|--------|------:|---------|-------|
| 1 | `SPF_FAIL` | 3.0 | `rspamd_spf_fail` | Header grep: `spf=fail` |
| 2 | `DMARC_POLICY_REJECT` | 4.5 | `rspamd_dmarc_reject` | Header grep: `dmarc=fail` |
| 3 | `RSPAMD_FALLBACK` | 0 | — | Informational: rspamd unreachable |

### Dynamic signals (live rspamd mode)

When connected to a real rspamd instance, every rspamd symbol with non-zero
score is passed through verbatim (e.g. `BAYES_SPAM`, `DKIM_SIGNED`,
`FORGED_SENDER`). Additionally:

| Signal | Score | Feature | Notes |
|--------|------:|---------|-------|
| `ACTION_<ACTION>` | 0 | `rspamd_action` | e.g. `ACTION_REJECT`, `ACTION_ADD_HEADER`, `ACTION_GREYLIST`. Carries `total_score` in detail |

---

## E2 SLM — Content & Language Analysis

**Engine field:** `"slm"`
**Service:** `services/e2_slm/index.js`
**Type:** Content classification (evolving toward behavioral)

### Built signals

| # | Signal | Max Score | Feature | Source |
|---|--------|----------:|---------|--------|
| 1 | `URGENCY_LANGUAGE` | 9.0 | `slm_urgency` | LLM + keyword fallback |
| 2 | `RSPAMD_REASONED_PHISH` | 4.5 | `slm_reasoned_phish` | Cross-signal: auth failure + urgency/threat |
| 3 | `IMPERSONATION_ATTEMPT` | 7.5 | `slm_impersonation` | LLM only |
| 4 | `FINANCIAL_REQUEST` | 7.5 | `slm_financial` | LLM only |
| 5 | `CREDENTIAL_HARVESTING` | 6.0 | `slm_credential` | LLM only |
| 6 | `EMOTIONAL_MANIPULATION` | 4.5 | `slm_emotional` | LLM only |
| 7 | `SOCIAL_ENGINEERING` | 6.0 | `slm_social_engineering` | LLM only |

### Proposed signals (conversation engine via SLM)

These require the gateway to assemble thread context from `email_metadata`
using `In-Reply-To`/`References` headers and pass it to E2.

| # | Signal | Feature | Description |
|---|--------|---------|-------------|
| 8 | `intent_action_request` | `slm_intent_action` | Classifies what the email wants the recipient to do (click, call, transfer, open, change password) |
| 9 | `perplexity_deviation` | `slm_perplexity` | Per-sender language model baseline — scores how unusual this email's writing style is for this sender |
| 10 | `topic_drift_financial` | `slm_topic_drift` | Thread was about topic X, latest message pivots to financial/payment |
| 11 | `urgency_injection` | `slm_urgency_inject` | First N messages in thread are calm, latest injects urgency |
| 12 | `sender_style_shift` | `slm_style_shift` | Writing style in latest message differs from same sender's earlier messages in the thread |
| 13 | `financial_escalation` | `slm_financial_esc` | Non-financial thread escalates to financial request |
| 14 | `bank_detail_change` | `slm_bank_change` | Payment/bank details modified mid-conversation |
| 15 | `pretexting_detection` | `slm_pretext` | Email skips normal business steps (no PO, no prior relationship, straight to payment) |

---

## E3 Stats DB — Behavioral Baselines

**Engine field:** `"stats_db"`
**Service:** `services/e3_stats_db/index.js`
**Type:** Behavioral (core engine)

This is the most signal-dense engine. All signals are pure-behavioral — derived
from per-org learned baselines, not signatures or threat intel.

### Group: Frequency baselines

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 1 | `first_time_sender` | 2.25 | `sdb_first_time_sender` | Yes |
| 2 | `dormant_sender_reactivation` | 2.7 | `sdb_dormant_reactivation` | Yes |
| 3 | `communication_cadence_shift` | 1.5 | — | **No** |
| 4 | `new_domain_surge` | 3.0 | — | **No** |

### Group: Sender volume anomaly

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 5 | `daily_count_spike` | 3.75 | `sdb_daily_spike` | Yes |
| 6 | `hourly_deviation` | 1.2 | — | **No** |
| 7 | `sender_burst` | 3.75 | `sdb_sender_burst` | Yes |
| 8 | `send_rate_change` | 1.8 | — | **No** |
| 9 | `silence_then_burst` | 3.3 | `sdb_silence_burst` | Yes |

### Group: Recipient anomaly

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 10 | `first_time_pair` | 1.2 | `sdb_first_time_pair` | Yes |
| 11 | `mass_bcc_detection` | 2.25 | `sdb_mass_bcc` | Yes |
| 12 | `recipient_count_anomaly` | 1.5 | — | **No** |

### Group: Time-of-day anomaly

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 13 | `off_hours_email` | 0.75 | `sdb_off_hours` | Yes |
| 14 | `weekend_activity_spike` | 2.25 | — | **No** |
| 15 | `schedule_deviation` | 1.05 | — | **No** |

### Group: Domain patterns

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 16 | `domain_first_seen` | 1.8 | `sdb_domain_first_seen` | Yes |
| 17 | `domain_first_seen_recent` | 1.5 | `sdb_domain_recent` | Yes |
| 18 | `domain_email_volume_trend` | 1.2 | — | **No** |
| 19 | `lookalike_domain` | 4.5 | `sdb_lookalike` | Yes |
| 20 | `freemail_to_corp` | 0.9 | `sdb_freemail_corp` | Yes |

### Group: Sender-recipient pair

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 21 | `pair_frequency_deviation` | 0.9 | — | **No** |

### Group: Volume & ratio metrics

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 22 | `size_distribution_anomaly` | 1.2 | `sdb_size_anomaly` | Yes |
| 23 | `link_density_change` | 1.8 | `sdb_link_density` | Yes |
| 24 | `attachment_rate_anomaly` | 2.25 | — | **No** |
| 25 | `bulk_vs_individual_ratio_shift` | 1.5 | — | **No** |

### Group: Attack patterns

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 26 | `sender_local_entropy` | 1.5 | `sdb_sender_local_entropy` | Yes |
| 27 | `reply_to_domain_mismatch` | 2.25 | `sdb_reply_to_mismatch` | Yes |
| 28 | `payloadless_financial` | 2.25 | `sdb_payloadless_financial` | Yes |
| 29 | `recipient_fanout_spike` | 2.25 | `sdb_recipient_fanout_spike` | Yes |
| 30 | `phone_number_lure` | 1.5 | `sdb_phone_number_lure` | Yes |
| 31 | `body_brevity_with_urgency` | 1.5 | `sdb_body_brevity_urgency` | Yes |
| 32 | `volume_zscore_anomaly` | 2.25 | `sdb_volume_zscore` | Yes |
| 33 | `newly_registered_domain` | 3.0 | `sdb_newly_registered` | Yes |
| 34 | `sender_domain_age_risk` | 1.5 | `sdb_domain_age_risk` | Yes |

### Stubbed (DATA_DEP — code-tagged, not yet firing)

| # | Signal | Blocked by |
|---|--------|-----------|
| 35 | `reply_rate_change` | Needs conversation threading |
| 36 | `volume_percentile` | Needs org-wide top-N snapshot |
| 37 | `timezone_mismatch` | Needs sending-IP geolocation |

### Proposed behavioral additions

| # | Signal | Feature | Description |
|---|--------|---------|-------------|
| 38 | `sender_style_deviation` | `sdb_style_deviation` | Body length, subject length, HTML ratio, link density, attachment rate all deviate from per-sender learned fingerprint |
| 39 | `multi_stage_ramp` | `sdb_multi_stage` | Intent escalation across a sender's last N emails (benign → benign → attack) |
| 40 | `recipient_risk_amplifier` | `sdb_recipient_risk` | Multiplies signal scores by recipient's historical susceptibility from feedback data |
| 41 | `seasonal_deviation` | `sdb_seasonal` | Current behavior vs same-period-last-quarter patterns |
| 42 | `behavior_changepoint` | `sdb_changepoint` | Detects the timestamp when a sender's behavioral distribution shifts abruptly (account compromise indicator) |
| 43 | `user_report_velocity` | `sdb_report_velocity` | 3+ users report same sender within 1 hour |
| 44 | `thread_participant_injection` | `sdb_thread_inject` | New sender appears in existing thread (structural check, no NLP needed) |
| 45 | `thread_reply_to_hijack` | `sdb_thread_hijack` | Reply-To domain changed mid-thread |
| 46 | `thread_velocity_spike` | `sdb_thread_velocity` | Thread pace suddenly accelerates (avg 1+ day gaps → <1 hour) |

### Unmapped signals (firing but invisible to the LR model)

The following 11 signals fire and appear in verdict details but have no
`FEATURE_NAMES` / `PATTERNS` entry, so the per-org model cannot learn from them:

```
communication_cadence_shift    new_domain_surge
hourly_deviation               send_rate_change
weekend_activity_spike         schedule_deviation
domain_email_volume_trend      pair_frequency_deviation
recipient_count_anomaly        attachment_rate_anomaly
bulk_vs_individual_ratio_shift
```

**Action required:** Add feature vector slots for these — entries in
`FEATURE_NAMES` and `PATTERNS` only. No engine code changes needed.

---

## E4 Graph DB — Relationship & Trust

**Engine field:** `"graph_db"`
**Service:** `services/e4_graph_db/index.js`
**Type:** Behavioral (relationship patterns)

### Group: Trust scoring

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 1 | `trust_score_low` | 2.25 | `g_trust_low` | Yes |
| 2 | `frequency_weight_low` | 1.2 | — | **No** |
| 3 | `no_reciprocity` | 1.5 | — | **No** |
| 4 | `young_relationship` | 1.05 | — | **No** |
| 5 | `trust_decay_dormant` | 1.8 | — | **No** |

### Group: Anomaly detection

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 6 | `first_time_external_sender` | 2.25 | `g_first_time_external` | Yes |
| 7 | `first_time_pair_graph` | 1.2 | `g_first_time_pair` | Yes |
| 8 | `direction_reversal` | 2.7 | `g_direction_reversal` | Yes |
| 9 | `pattern_break` | 1.35 | — | **No** |
| 10 | `new_contact_burst` | 3.0 | `g_new_contact_burst` | Yes |
| 11 | `re_emergence_after_dormancy` | 2.25 | `g_dormant_reactivation` | Yes |

### Group: Org hierarchy

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 12 | `vip_display_name_mismatch` | 2.25 / 4.5 | `g_vip_mismatch` | Yes |
| 13 | `executive_impersonation` | 3.75 | `g_vip_mismatch` | Yes (same slot) |

### Group: Clique analysis

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 14 | `compromised_account_spray` | 4.2 | `g_compromised_spray` | Yes |

### Group: Temporal graph

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 15 | `sudden_new_contact_burst` | 2.25 | — | **No** |
| 16 | `dormant_reactivation` | 1.5 | — | **No** |
| 17 | `edge_frequency_acceleration` | 1.35 | `g_edge_acceleration` | Yes |

### Group: Identity resolution

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 18 | `display_name_reuse` | 1.5 | — | **No** |

### Stubbed (DATA_DEP — in code, not emitting)

| # | Signal | Blocked by |
|---|--------|-----------|
| 19 | `cross_department_contact` | Needs LDAP/AD department tags |
| 20 | `skip_level_contact` | Needs org chart integration |
| 21 | `cluster_boundary_cross` | Needs community detection |
| 22 | `isolated_node_active` | Needs graph connectivity metrics |
| 23 | `multi_cluster_spray` | Needs community detection |
| 24 | `pattern_shift` | Needs temporal pattern model |
| 25 | `alias_chain` | Needs alias resolution |
| 26 | `similar_name_different_domain` | Needs fuzzy name matching |

### Proposed behavioral additions

| # | Signal | Feature | Description |
|---|--------|---------|-------------|
| 27 | `hierarchy_violation` | `g_hierarchy_violation` | Email bypasses normal communication chain (junior gets direct "CEO" email) |
| 28 | `clique_penetration` | `g_clique_penetration` | External sender reaches into a tight internal communication group |
| 29 | `department_boundary_cross` | `g_dept_boundary` | Sender from vendor billing contacts engineering (never happened before) |
| 30 | `org_flow_reversal` | `g_org_flow_reversal` | Org always initiates with this vendor; now vendor initiates urgent request |
| 31 | `shadow_hierarchy_deviation` | `g_shadow_hierarchy` | Learned real communication hierarchy disagrees with claimed authority |
| 32 | `relationship_content_anomaly` | `g_rel_content_anomaly` | Pair always exchanges technical docs, now requesting wire transfer |
| 33 | `relationship_tempo_break` | `g_rel_tempo_break` | Monthly-invoice vendor sending mid-cycle |

### Unmapped signals (firing but invisible to model)

```
frequency_weight_low       no_reciprocity
young_relationship         trust_decay_dormant
pattern_break              sudden_new_contact_burst
dormant_reactivation       display_name_reuse
```

---

## E5 URL Scanner — URL & Domain Analysis

**Engine field:** `"url_scanner"`
**Service:** `services/e5_url_scanner/index.js`
**Type:** Mixed (heuristic + intel + behavioral)

### Group: Domain analysis

| # | Signal | Score | Feature | Type |
|---|--------|------:|---------|------|
| 1 | `url_numeric_ip` | 3.0 | `url_numeric_ip` | Heuristic |
| 2 | `domain_idn_homograph` | 3.0 | `url_idn_homograph` | Heuristic |
| 3 | `domain_excessive_subdomains` | 1.5 | `url_excessive_subdomains` | Heuristic |
| 4 | `domain_dga_like` | 2.25 | `url_dga_like` | Heuristic |
| 5 | `suspicious_tld` | 3.0 | `url_suspicious_tld` | **Intel** |
| 6 | `url_user_password` | 3.75 | — | **No** |
| 7 | `url_data_uri` | 3.75 | — | **No** |
| 8 | `url_base64_payload` | 2.25 | — | **No** |
| 9 | `url_abnormal_path_length` | 1.2 | — | **No** |
| 10 | `url_shortener` | 1.5 | `url_shortener` | Heuristic |
| 11 | `reputation_blocklist_hit` | 6.0 | `url_blocklist_hit` | **Intel** |

### Group: Redirect chain

| # | Signal | Score | Feature | Type |
|---|--------|------:|---------|------|
| 12 | `redirect_chain_long` | 3.0 | `url_redirect_long` | Heuristic |
| 13 | `redirect_domain_hops` | 2.25 | — | **No** |

### Group: Landing page

| # | Signal | Score | Feature | Type |
|---|--------|------:|---------|------|
| 14 | `landing_credential_form` | 4.5 | `url_landing_cred_form` | Behavioral |
| 15 | `landing_form_domain_mismatch` | 3.75 | `url_landing_mismatch` | Behavioral |
| 16 | `landing_obfuscated_js` | 2.25 | `url_obfuscated_js` | Heuristic |
| 17 | `landing_hidden_iframe` | 2.25 | — | **No** |

### Group: Meta/informational

| # | Signal | Score | Feature | Notes |
|---|--------|------:|---------|-------|
| 18 | `url_scan_cache_hit` | 0 | — | Informational only |
| 19 | `urls_present` | 0 | — | Informational: count of URLs found |

### Proposed behavioral additions

| # | Signal | Feature | Description |
|---|--------|---------|-------------|
| 20 | `url_behavioral_novelty` | `url_behavioral_novelty` | URL never seen across any org + registered <7d + sent to multiple orgs simultaneously |
| 21 | `url_sender_url_mismatch` | `url_sender_mismatch` | Sender has never included URLs from this TLD/domain before |
| 22 | `url_campaign_pattern` | `url_campaign_pattern` | Same URL structure (not same URL) hitting 3+ orgs within 1 hour |

### Unmapped signals (firing but invisible to model)

```
url_user_password          url_data_uri
url_base64_payload         url_abnormal_path_length
redirect_domain_hops       landing_hidden_iframe
```

---

## E6 Attachment — File Analysis

**Engine field:** `"attachment"`
**Service:** `services/e6_attachment/index.js`
**Type:** Intel-based (blocklist) — needs behavioral evolution
**Status:** Stub — PRD calls for 27 signals, only 1 built

### Built signals

| # | Signal | Score | Feature | Type |
|---|--------|------:|---------|------|
| 1 | `dangerous_extension` | 6.0 | `att_dangerous` | **Intel** (extension blocklist) |

### Proposed behavioral replacements

| # | Signal | Feature | Description |
|---|--------|---------|-------------|
| 2 | `attachment_sender_novelty` | `att_sender_novelty` | This sender has never sent files of this type before |
| 3 | `attachment_entropy_anomaly` | `att_entropy` | File entropy suggests packed/encrypted payload regardless of extension |
| 4 | `attachment_relationship_anomaly` | `att_rel_anomaly` | This pair always exchanges PDFs, now sending macro-enabled docs |
| 5 | `attachment_macro_context` | `att_macro_context` | Macro-enabled doc + financial language + first-time sender (compound behavioral) |
| 6 | `attachment_type_mismatch` | `att_type_mismatch` | File claims to be .pdf but magic bytes indicate .exe |

---

## E7 Visual — Landing Page Analysis

**Engine field:** `"visual"`
**Service:** `services/e7_visual/index.js`
**Type:** Behavioral
**Status:** Stub — PRD calls for 18 signals, only 1 built

### Built signals

| # | Signal | Score | Feature |
|---|--------|------:|---------|
| 1 | `credential_form_detected` | 4.5 | `vis_cred_form` |

### Proposed behavioral additions

| # | Signal | Feature | Description |
|---|--------|---------|-------------|
| 2 | `visual_brand_behavioral` | `vis_brand_behavioral` | Page looks like Microsoft login but domain behavioral profile doesn't match Microsoft infrastructure |
| 3 | `visual_harvesting_ux` | `vis_harvesting_ux` | Page uses urgency timers, fake progress bars, session-expired messaging (UX patterns of credential harvesting) |
| 4 | `visual_internal_tool_mimic` | `vis_internal_mimic` | Landing page mimics the org's actual SSO page (per-org learned) |

---

## E8 Sandbox — Dynamic Execution

**Engine field:** `"sandbox"`
**Service:** `services/e8_sandbox/index.js`
**Type:** Behavioral (dynamic analysis)
**Status:** Stub — returns `[]`. Gating lives in gateway; execution is async/queued.

No signals currently implemented. PRD describes 13 dynamic-behavior signals
for Phase 3+ (file detonation, C2 callback detection, process injection, etc.).

---

## E9 Specialized ML — Header, Encoding & Structure

**Engine field:** `"specialized_ml"`
**Service:** `services/e9_specialized_ml/index.js`
**Type:** Heuristic/ML (structural analysis)

### Group: Homoglyph detection

| # | Signal | Score | Feature |
|---|--------|------:|---------|
| 1 | `mixed_script_domain` | 4.5 | `sml_mixed_script` |
| 2 | `confusable_chars` | 3.0 | `sml_confusable` |
| 3 | `idn_lookalike` | 4.5 | `sml_idn_lookalike` |

### Group: Header anomaly

| # | Signal | Score | Feature |
|---|--------|------:|---------|
| 4 | `header_order_anomaly` | 1.05 | `sml_header_order` |
| 5 | `unusual_header_combo` | 2.25 | `sml_unusual_combo` |
| 6 | `received_chain_forged` | 3.0 | `sml_received_forged` |
| 7 | `message_id_format_anomaly` | 1.5 | `sml_message_id_anom` |

### Group: Encoding abuse

| # | Signal | Score | Feature |
|---|--------|------:|---------|
| 8 | `base64_content_obfuscation` | 2.25 | `sml_base64_obf` |
| 9 | `quoted_printable_abuse` | 1.5 | `sml_qp_abuse` |
| 10 | `exotic_charset` | 1.5 | `sml_exotic_charset` |

### Group: Structural/MIME

| # | Signal | Score | Feature | Mapped? |
|---|--------|------:|---------|:-------:|
| 11 | `mime_tree_deep` | 1.5 | `sml_mime_deep` | Yes |
| 12 | `nested_multipart_abuse` | 2.25 | `sml_nested_mp` | Yes |
| 13 | `content_type_mismatch` | 2.25 | — | **No** |

### Proposed behavioral additions

| # | Signal | Feature | Description |
|---|--------|---------|-------------|
| 14 | `header_client_drift` | `sml_client_drift` | Sender always uses Outlook headers, this email has Gmail-style headers (per-sender baseline) |
| 15 | `header_infra_fingerprint` | `sml_infra_drift` | Sending infrastructure pattern (Received chain hop count, MTA software, TLS versions) changed for this sender |
| 16 | `header_persona_inconsistency` | `sml_persona_inconsist` | Claimed VP title but infrastructure patterns match a bulk-sending tool |

### Unmapped signals

```
content_type_mismatch
```

---

## Gateway & Synthesizer

**Gateway** (`services/gateway/index.js`): Orchestrator only. Dispatches emails
to engines, collects signals, runs feature extraction, invokes per-org model,
writes verdicts. Emits no signals.

**Synthesizer** (`services/synthesizer/index.js`): Consumes signal list,
produces verdict object (verdict, label, confidence, threat_score, reason).
Emits no signals.

---

## Feature Vector Reference

The feature vector is defined in `shared/features.js`. Current slot count: **46**.
Signals are mapped via regex patterns — first match wins.

### Current FEATURE_NAMES (46 slots)

```
Index  Feature                    Engine
─────  ─────────────────────────  ──────
 0     rspamd_spf_fail            E1
 1     rspamd_dmarc_reject        E1
 2     rspamd_action              E1
 3     slm_urgency                E2
 4     slm_reasoned_phish         E2
 5     slm_impersonation          E2
 6     slm_financial              E2
 7     slm_credential             E2
 8     slm_emotional              E2
 9     slm_social_engineering     E2
10     sdb_first_time_sender      E3
11     sdb_first_time_pair        E3
12     sdb_off_hours              E3
13     sdb_sender_burst           E3
14     sdb_domain_first_seen      E3
15     sdb_domain_recent          E3
16     sdb_daily_spike            E3
17     sdb_silence_burst          E3
18     sdb_lookalike              E3
19     sdb_freemail_corp          E3
20     sdb_mass_bcc               E3
21     sdb_size_anomaly           E3
22     sdb_link_density           E3
23     sdb_dormant_reactivation   E3
24     sdb_sender_local_entropy   E3
25     sdb_reply_to_mismatch      E3
26     sdb_payloadless_financial  E3
27     sdb_recipient_fanout_spike E3
28     sdb_phone_number_lure      E3
29     sdb_body_brevity_urgency   E3
30     sdb_volume_zscore          E3
31     sdb_domain_age_risk        E3
32     sdb_newly_registered       E3
33     g_trust_low                E4
34     g_first_time_external      E4
35     g_direction_reversal       E4
36     g_new_contact_burst        E4
37     g_vip_mismatch             E4
38     g_compromised_spray        E4
39     g_dormant_reactivation     E4
40     g_edge_acceleration        E4
41     g_first_time_pair          E4
42-52  url_* (11 slots)           E5
53     att_dangerous              E6
54     vis_cred_form              E7
55-66  sml_* (12 slots)           E9
```

### Unmapped signals summary (19 total — firing but model-invisible)

**E3 Stats DB (11):**
`communication_cadence_shift`, `new_domain_surge`, `hourly_deviation`,
`send_rate_change`, `weekend_activity_spike`, `schedule_deviation`,
`domain_email_volume_trend`, `pair_frequency_deviation`,
`recipient_count_anomaly`, `attachment_rate_anomaly`,
`bulk_vs_individual_ratio_shift`

**E4 Graph DB (7):**
`frequency_weight_low`, `no_reciprocity`, `young_relationship`,
`trust_decay_dormant`, `pattern_break`, `sudden_new_contact_burst`,
`display_name_reuse`

**E5 URL Scanner (6):**
`url_user_password`, `url_data_uri`, `url_base64_payload`,
`url_abnormal_path_length`, `redirect_domain_hops`, `landing_hidden_iframe`

**E9 Specialized ML (1):**
`content_type_mismatch`

---

## Behavioral vs Intel/Signature Classification

Every signal categorized by detection approach:

### Behavioral (73 signals — learns from patterns, hard to evade)

All of E3 (34), most of E4 (18), E5 landing page analysis (4), E7 (1),
E9 header/encoding anomalies (13), E2 cross-signal (1), E2 content
classification (6 — partially behavioral).

### Heuristic (12 signals — rule-based but not signature/IOC)

E5 domain structure checks (numeric IP, IDN, subdomains, DGA, shortener,
redirect chain, obfuscated JS, data URI, base64 payload, path length),
E1 authentication checks (SPF/DKIM/DMARC — necessary but not behavioral).

### Intel/Signature-based (3 signals — needs evolution)

| Signal | Engine | Replace with |
|--------|--------|-------------|
| `suspicious_tld` | E5 | Behavioral URL novelty |
| `reputation_blocklist_hit` | E5 | Cross-org behavioral intelligence |
| `dangerous_extension` | E6 | Sender attachment novelty + entropy |

### Current behavioral ratio: **~76%** (73/96)
### Target behavioral ratio: **>90%** (after replacing intel signals + adding proposed)

---

## Evasion Cost Matrix

Signals ranked by how hard they are for attackers to evade:

| Evasion Difficulty | Signals | Implication |
|---|---|---|
| **Near impossible** | Cross-org behavioral patterns, org communication topology, relationship baselines | Attacker can't know internal org patterns or what other orgs have seen |
| **Very hard** | Sender fingerprint, temporal attack sequences, behavior changepoints, thread analysis | Must study victim's habits for weeks; must maintain behavioral consistency |
| **Hard** | Trust scores, frequency baselines, volume anomalies, time patterns | Must match victim's normal sending behavior |
| **Medium** | Header/encoding anomalies, MIME structure, homoglyphs | Can switch tools but leaves traces |
| **Easy** | Content keywords (urgency, financial) | Rephrase the text |
| **Trivial** | URL blocklists, extension blocklists, TLD lists | Register new domain / rename file |

**Design principle:** Weight model features by evasion cost. Signals that are
hard to evade should carry more weight than those easily bypassed.

---

## Roadmap Priority

| Priority | What | Effort | Impact |
|---|---|---|---|
| **P0** | Map 19 unmapped signals to feature vector | 1 day | Free model improvement |
| **P1** | E3 sender fingerprinting (style deviation) | 2-3 weeks | Highest ROI behavioral signal |
| **P1** | Gateway thread assembly + E3 structural thread signals | 2 weeks | Biggest blind spot |
| **P2** | E2 conversation-aware prompting (thread context to SLM) | 1-2 weeks | Depends on thread assembly |
| **P2** | E4 topology signals (hierarchy, clique, dept boundary) | 2 weeks | Graph DB already exists |
| **P2** | E9 per-sender client/infra drift | 1-2 weeks | Header data already exists |
| **P3** | E5/E6 behavioral URL & attachment analysis | 2-3 weeks | Replaces intel-based signals |
| **P3** | E2 perplexity scoring (per-sender language baseline) | 3 weeks | Requires per-sender LM baseline |
| **P3** | E7 behavioral visual analysis | 1-2 weeks | Extends existing engine |
| **P4** | Cross-org behavioral intelligence layer | 4-6 weeks | Architecture change — the long-term moat |
| **P4** | Adaptive per-org thresholds | 2 weeks | Extends org_context |
| **P4** | Recipient vulnerability scoring from feedback | 2 weeks | Needs feedback loop maturity |
