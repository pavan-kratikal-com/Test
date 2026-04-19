import test from "node:test";
import assert from "node:assert/strict";
import { signalsToFeatures, FEATURE_NAMES, featureIndex } from "../shared/features.js";

test("FEATURE_NAMES: stable, non-empty, unique", () => {
  assert.ok(FEATURE_NAMES.length >= 40);
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length);
});

test("signalsToFeatures: empty signals → zero vector", () => {
  const v = signalsToFeatures([]);
  assert.equal(v.length, FEATURE_NAMES.length);
  assert.ok(v.every((x) => x === 0));
});

test("signalsToFeatures: rspamd DMARC_POLICY_REJECT flips rspamd_dmarc_reject", () => {
  const v = signalsToFeatures([
    { engine: "rspamd", signal: "DMARC_POLICY_REJECT", score: 3 },
  ]);
  assert.equal(v[featureIndex("rspamd_dmarc_reject")], 1);
});

test("signalsToFeatures: multiple signals flip multiple features", () => {
  const v = signalsToFeatures([
    { engine: "rspamd", signal: "SPF_FAIL", score: 2 },
    { engine: "slm", signal: "URGENCY_LANGUAGE", score: 1.5 },
    { engine: "stats_db", signal: "first_time_sender", score: 1.5 },
    { engine: "attachment", signal: "dangerous_extension", score: 4 },
  ]);
  assert.equal(v[featureIndex("rspamd_spf_fail")], 1);
  assert.equal(v[featureIndex("slm_urgency")], 1);
  assert.equal(v[featureIndex("sdb_first_time_sender")], 1);
  assert.equal(v[featureIndex("att_dangerous")], 1);
});

test("signalsToFeatures: unknown engine.signal leaves vector alone", () => {
  const v = signalsToFeatures([{ engine: "unknown", signal: "X", score: 1 }]);
  assert.ok(v.every((x) => x === 0));
});

test("signalsToFeatures: url_scanner.suspicious_tld → url_suspicious_tld", () => {
  const v = signalsToFeatures([
    { engine: "url_scanner", signal: "suspicious_tld", score: 2 },
  ]);
  assert.equal(v[featureIndex("url_suspicious_tld")], 1);
});

test("signalsToFeatures: specialized_ml.mixed_script_domain → sml_mixed_script", () => {
  const v = signalsToFeatures([
    { engine: "specialized_ml", signal: "mixed_script_domain", score: 3 },
  ]);
  assert.equal(v[featureIndex("sml_mixed_script")], 1);
});

// ── New conversation-aware SLM signal mappings ──────────────────────────

test("signalsToFeatures: slm conversation signals map correctly", () => {
  const v = signalsToFeatures([
    { engine: "slm", signal: "INTENT_ACTION_REQUEST", score: 3 },
    { engine: "slm", signal: "PERPLEXITY_DEVIATION", score: 2 },
    { engine: "slm", signal: "TOPIC_DRIFT_FINANCIAL", score: 3 },
    { engine: "slm", signal: "URGENCY_INJECTION", score: 3 },
    { engine: "slm", signal: "SENDER_STYLE_SHIFT", score: 2 },
    { engine: "slm", signal: "FINANCIAL_ESCALATION", score: 4 },
    { engine: "slm", signal: "BANK_DETAIL_CHANGE", score: 5 },
    { engine: "slm", signal: "PRETEXTING_DETECTION", score: 3 },
  ]);
  assert.equal(v[featureIndex("slm_intent_action")], 1);
  assert.equal(v[featureIndex("slm_perplexity")], 1);
  assert.equal(v[featureIndex("slm_topic_drift")], 1);
  assert.equal(v[featureIndex("slm_urgency_inject")], 1);
  assert.equal(v[featureIndex("slm_style_shift")], 1);
  assert.equal(v[featureIndex("slm_financial_esc")], 1);
  assert.equal(v[featureIndex("slm_bank_change")], 1);
  assert.equal(v[featureIndex("slm_pretext")], 1);
});

// ── New E3 behavioral signal mappings ───────────────────────────────────

test("signalsToFeatures: E3 behavioral signals map correctly", () => {
  const v = signalsToFeatures([
    { engine: "stats_db", signal: "sender_style_deviation", score: 2 },
    { engine: "stats_db", signal: "multi_stage_ramp", score: 2 },
    { engine: "stats_db", signal: "behavior_changepoint", score: 2 },
    { engine: "stats_db", signal: "thread_participant_injection", score: 2 },
    { engine: "stats_db", signal: "thread_reply_to_hijack", score: 3 },
    { engine: "stats_db", signal: "thread_velocity_spike", score: 1.5 },
  ]);
  assert.equal(v[featureIndex("sdb_style_deviation")], 1);
  assert.equal(v[featureIndex("sdb_multi_stage")], 1);
  assert.equal(v[featureIndex("sdb_changepoint")], 1);
  assert.equal(v[featureIndex("sdb_thread_inject")], 1);
  assert.equal(v[featureIndex("sdb_thread_hijack")], 1);
  assert.equal(v[featureIndex("sdb_thread_velocity")], 1);
});

// ── New E4 topology signal mappings ─────────────────────────────────────

test("signalsToFeatures: E4 topology signals map correctly", () => {
  const v = signalsToFeatures([
    { engine: "graph_db", signal: "hierarchy_violation", score: 2 },
    { engine: "graph_db", signal: "clique_penetration", score: 1.5 },
    { engine: "graph_db", signal: "department_boundary_cross", score: 1.5 },
    { engine: "graph_db", signal: "org_flow_reversal", score: 2 },
    { engine: "graph_db", signal: "relationship_tempo_break", score: 1.5 },
    { engine: "graph_db", signal: "shadow_hierarchy_deviation", score: 2.5 },
  ]);
  assert.equal(v[featureIndex("g_hierarchy_violation")], 1);
  assert.equal(v[featureIndex("g_clique_penetration")], 1);
  assert.equal(v[featureIndex("g_dept_boundary")], 1);
  assert.equal(v[featureIndex("g_org_flow_reversal")], 1);
  assert.equal(v[featureIndex("g_rel_tempo_break")], 1);
  assert.equal(v[featureIndex("g_shadow_hierarchy")], 1);
});

// ── New E5/E6/E7/E9 signal mappings ────────────────────────────────────

test("signalsToFeatures: E5 behavioral URL signals map correctly", () => {
  const v = signalsToFeatures([
    { engine: "url_scanner", signal: "url_behavioral_novelty", score: 3 },
    { engine: "url_scanner", signal: "url_sender_url_mismatch", score: 1.8 },
    { engine: "url_scanner", signal: "url_campaign_pattern", score: 2 },
  ]);
  assert.equal(v[featureIndex("url_behavioral_novelty")], 1);
  assert.equal(v[featureIndex("url_sender_mismatch")], 1);
  assert.equal(v[featureIndex("url_campaign_pattern")], 1);
});

test("signalsToFeatures: E6 attachment signals map correctly", () => {
  const v = signalsToFeatures([
    { engine: "attachment", signal: "attachment_sender_novelty", score: 2 },
    { engine: "attachment", signal: "attachment_entropy_anomaly", score: 2 },
    { engine: "attachment", signal: "attachment_relationship_anomaly", score: 2 },
    { engine: "attachment", signal: "attachment_macro_context", score: 3 },
    { engine: "attachment", signal: "attachment_type_mismatch", score: 3 },
  ]);
  assert.equal(v[featureIndex("att_sender_novelty")], 1);
  assert.equal(v[featureIndex("att_entropy")], 1);
  assert.equal(v[featureIndex("att_rel_anomaly")], 1);
  assert.equal(v[featureIndex("att_macro_context")], 1);
  assert.equal(v[featureIndex("att_type_mismatch")], 1);
});

test("signalsToFeatures: E7 visual signals map correctly", () => {
  const v = signalsToFeatures([
    { engine: "visual", signal: "visual_brand_behavioral", score: 3 },
    { engine: "visual", signal: "visual_harvesting_ux", score: 2 },
    { engine: "visual", signal: "visual_internal_tool_mimic", score: 3.5 },
  ]);
  assert.equal(v[featureIndex("vis_brand_behavioral")], 1);
  assert.equal(v[featureIndex("vis_harvesting_ux")], 1);
  assert.equal(v[featureIndex("vis_internal_mimic")], 1);
});

test("signalsToFeatures: E9 behavioral header signals map correctly", () => {
  const v = signalsToFeatures([
    { engine: "specialized_ml", signal: "header_client_drift", score: 1.8 },
    { engine: "specialized_ml", signal: "header_infra_fingerprint", score: 1.5 },
    { engine: "specialized_ml", signal: "header_persona_inconsistency", score: 2 },
    { engine: "specialized_ml", signal: "content_type_mismatch", score: 1.5 },
  ]);
  assert.equal(v[featureIndex("sml_client_drift")], 1);
  assert.equal(v[featureIndex("sml_infra_drift")], 1);
  assert.equal(v[featureIndex("sml_persona_inconsist")], 1);
  assert.equal(v[featureIndex("sml_content_type_mismatch")], 1);
});

// ── Previously unmapped E3 signals now have feature slots ───────────────

test("signalsToFeatures: previously unmapped E3 signals now map correctly", () => {
  const v = signalsToFeatures([
    { engine: "stats_db", signal: "communication_cadence_shift", score: 1.5 },
    { engine: "stats_db", signal: "new_domain_surge", score: 2 },
    { engine: "stats_db", signal: "hourly_deviation", score: 1.5 },
    { engine: "stats_db", signal: "send_rate_change", score: 1.5 },
    { engine: "stats_db", signal: "weekend_activity_spike", score: 1.5 },
    { engine: "stats_db", signal: "pair_frequency_deviation", score: 1.5 },
    { engine: "stats_db", signal: "recipient_count_anomaly", score: 1.5 },
    { engine: "stats_db", signal: "attachment_rate_anomaly", score: 1.5 },
  ]);
  assert.equal(v[featureIndex("sdb_cadence_shift")], 1);
  assert.equal(v[featureIndex("sdb_domain_surge")], 1);
  assert.equal(v[featureIndex("sdb_hourly_deviation")], 1);
  assert.equal(v[featureIndex("sdb_send_rate_change")], 1);
  assert.equal(v[featureIndex("sdb_weekend_spike")], 1);
  assert.equal(v[featureIndex("sdb_pair_freq_deviation")], 1);
  assert.equal(v[featureIndex("sdb_recipient_count_anomaly")], 1);
  assert.equal(v[featureIndex("sdb_attachment_rate_anomaly")], 1);
});
