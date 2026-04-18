// Feature-vector extraction from a verdict's signal list.
//
// We pick a stable, named set of signal features (buckets) so the
// per-org logistic-regression model has a consistent feature space
// across training and inference. When new signals are added, add them
// to FEATURE_NAMES with `feature-${name}`; existing models still work
// (unknown signals map to unused slots in the vector).
export const FEATURE_NAMES = [
  // rspamd
  "rspamd_spf_fail", "rspamd_dmarc_reject", "rspamd_action",
  // slm
  "slm_urgency", "slm_reasoned_phish",
  "slm_impersonation", "slm_financial", "slm_credential",
  "slm_emotional", "slm_social_engineering",
  // stats_db
  "sdb_first_time_sender", "sdb_first_time_pair", "sdb_off_hours",
  "sdb_sender_burst", "sdb_domain_first_seen", "sdb_domain_recent",
  "sdb_daily_spike", "sdb_silence_burst", "sdb_lookalike", "sdb_freemail_corp",
  "sdb_mass_bcc", "sdb_size_anomaly", "sdb_link_density", "sdb_dormant_reactivation",
  "sdb_sender_local_entropy", "sdb_reply_to_mismatch", "sdb_payloadless_financial",
  "sdb_recipient_fanout_spike", "sdb_phone_number_lure", "sdb_body_brevity_urgency",
  "sdb_volume_zscore", "sdb_domain_age_risk",
  // graph_db
  "g_trust_low", "g_first_time_external", "g_direction_reversal",
  "g_new_contact_burst", "g_vip_mismatch", "g_compromised_spray",
  "g_dormant_reactivation", "g_edge_acceleration", "g_first_time_pair",
  // url_scanner
  "url_numeric_ip", "url_idn_homograph", "url_excessive_subdomains",
  "url_dga_like", "url_suspicious_tld", "url_shortener",
  "url_redirect_long", "url_landing_cred_form", "url_landing_mismatch",
  "url_blocklist_hit", "url_obfuscated_js",
  // attachment
  "att_dangerous",
  // visual
  "vis_cred_form",
  // specialized_ml
  "sml_mixed_script", "sml_confusable", "sml_idn_lookalike",
  "sml_header_order", "sml_unusual_combo", "sml_received_forged",
  "sml_message_id_anom", "sml_base64_obf", "sml_qp_abuse",
  "sml_exotic_charset", "sml_mime_deep", "sml_nested_mp",
];

// Maps a signal name (engine-independent substring) to feature index.
// Order matters — first match wins.
const PATTERNS = [
  [/^rspamd\..*spf_fail/i, "rspamd_spf_fail"],
  [/^rspamd\..*dmarc/i, "rspamd_dmarc_reject"],
  [/^rspamd\.action_/i, "rspamd_action"],
  [/^slm\.urgency_language/i, "slm_urgency"],
  [/^slm\.rspamd_reasoned/i, "slm_reasoned_phish"],
  [/^slm\.impersonation/i, "slm_impersonation"],
  [/^slm\.financial/i, "slm_financial"],
  [/^slm\.credential/i, "slm_credential"],
  [/^slm\.emotional/i, "slm_emotional"],
  [/^slm\.social_engineering/i, "slm_social_engineering"],
  [/stats_db\.first_time_sender/i, "sdb_first_time_sender"],
  [/stats_db\.first_time_pair/i, "sdb_first_time_pair"],
  [/stats_db\.off_hours/i, "sdb_off_hours"],
  [/stats_db\.sender_burst/i, "sdb_sender_burst"],
  [/stats_db\.domain_first_seen_recent/i, "sdb_domain_recent"],
  [/stats_db\.domain_first_seen/i, "sdb_domain_first_seen"],
  [/stats_db\.daily_count_spike/i, "sdb_daily_spike"],
  [/stats_db\.silence_then_burst/i, "sdb_silence_burst"],
  [/stats_db\.lookalike_domain/i, "sdb_lookalike"],
  [/stats_db\.freemail_to_corp/i, "sdb_freemail_corp"],
  [/stats_db\.mass_bcc/i, "sdb_mass_bcc"],
  [/stats_db\.size_distribution/i, "sdb_size_anomaly"],
  [/stats_db\.link_density/i, "sdb_link_density"],
  [/stats_db\.dormant_sender/i, "sdb_dormant_reactivation"],
  [/stats_db\.sender_local_entropy/i, "sdb_sender_local_entropy"],
  [/stats_db\.reply_to_domain_mismatch/i, "sdb_reply_to_mismatch"],
  [/stats_db\.payloadless_financial/i, "sdb_payloadless_financial"],
  [/stats_db\.recipient_fanout_spike/i, "sdb_recipient_fanout_spike"],
  [/stats_db\.phone_number_lure/i, "sdb_phone_number_lure"],
  [/stats_db\.body_brevity_with_urgency/i, "sdb_body_brevity_urgency"],
  [/stats_db\.volume_zscore_anomaly/i, "sdb_volume_zscore"],
  [/stats_db\.sender_domain_age_risk/i, "sdb_domain_age_risk"],
  [/graph_db\.trust_score_low/i, "g_trust_low"],
  [/graph_db\.first_time_external/i, "g_first_time_external"],
  [/graph_db\.direction_reversal/i, "g_direction_reversal"],
  [/graph_db\.new_contact_burst/i, "g_new_contact_burst"],
  [/graph_db\.(vip|executive)/i, "g_vip_mismatch"],
  [/graph_db\.compromised_account_spray/i, "g_compromised_spray"],
  [/graph_db\.(re_emergence|dormant_reactivation)/i, "g_dormant_reactivation"],
  [/graph_db\.edge_frequency/i, "g_edge_acceleration"],
  [/graph_db\.first_time_pair/i, "g_first_time_pair"],
  [/url_scanner\.url_numeric_ip/i, "url_numeric_ip"],
  [/url_scanner\.domain_idn_homograph/i, "url_idn_homograph"],
  [/url_scanner\.domain_excessive_subdomains/i, "url_excessive_subdomains"],
  [/url_scanner\.domain_dga_like/i, "url_dga_like"],
  [/url_scanner\.suspicious_tld/i, "url_suspicious_tld"],
  [/url_scanner\.url_shortener/i, "url_shortener"],
  [/url_scanner\.redirect_chain_long/i, "url_redirect_long"],
  [/url_scanner\.landing_credential_form/i, "url_landing_cred_form"],
  [/url_scanner\.landing_form_domain_mismatch/i, "url_landing_mismatch"],
  [/url_scanner\.reputation_blocklist/i, "url_blocklist_hit"],
  [/url_scanner\.landing_obfuscated_js/i, "url_obfuscated_js"],
  [/attachment\.dangerous_extension/i, "att_dangerous"],
  [/visual\.credential_form/i, "vis_cred_form"],
  [/specialized_ml\.mixed_script/i, "sml_mixed_script"],
  [/specialized_ml\.confusable_chars/i, "sml_confusable"],
  [/specialized_ml\.idn_lookalike/i, "sml_idn_lookalike"],
  [/specialized_ml\.header_order/i, "sml_header_order"],
  [/specialized_ml\.unusual_header_combo/i, "sml_unusual_combo"],
  [/specialized_ml\.received_chain_forged/i, "sml_received_forged"],
  [/specialized_ml\.message_id_format/i, "sml_message_id_anom"],
  [/specialized_ml\.base64_content/i, "sml_base64_obf"],
  [/specialized_ml\.quoted_printable/i, "sml_qp_abuse"],
  [/specialized_ml\.exotic_charset/i, "sml_exotic_charset"],
  [/specialized_ml\.mime_tree_deep/i, "sml_mime_deep"],
  [/specialized_ml\.nested_multipart/i, "sml_nested_mp"],
];

// Produce a fixed-length binary feature vector from a list of signals.
export function signalsToFeatures(signals) {
  const vec = new Array(FEATURE_NAMES.length).fill(0);
  for (const s of signals) {
    const key = `${s.engine}.${s.signal}`;
    for (const [re, feat] of PATTERNS) {
      if (re.test(key)) {
        const idx = FEATURE_NAMES.indexOf(feat);
        if (idx >= 0) vec[idx] = 1;
        break;
      }
    }
  }
  return vec;
}

export function featureIndex(name) {
  return FEATURE_NAMES.indexOf(name);
}
