// Feature-vector extraction from a verdict's signal list.
//
// We pick a stable, named set of signal features (buckets) so the
// per-org logistic-regression model has a consistent feature space
// across training and inference. When new signals are added, add them
// to FEATURE_NAMES with `feature-${name}`; existing models still work
// (unknown signals map to unused slots in the vector).
export const FEATURE_NAMES = [
  // rspamd (3)
  "rspamd_spf_fail", "rspamd_dmarc_reject", "rspamd_action",

  // slm — credential theft (6)
  "slm_credential", "slm_qr_phishing", "slm_consent_oauth",
  "slm_device_code", "slm_password_reset", "slm_mfa_fatigue",

  // slm — BEC / financial (4)
  "slm_financial", "slm_payroll_diversion", "slm_invoice_fraud",
  "slm_gift_card",

  // slm — impersonation (7)
  "slm_impersonation", "slm_exec_impersonation", "slm_brand_impersonation",
  "slm_lookalike_domain", "slm_display_name_spoof", "slm_reply_to_mismatch",
  "slm_internal_domain_spoof",

  // slm — social engineering (8)
  "slm_urgency", "slm_emotional", "slm_authority",
  "slm_social_engineering", "slm_scarcity", "slm_reciprocity",
  "slm_callback_toad", "slm_deepfake_ref",

  // slm — malware / payload (5)
  "slm_malware", "slm_suspicious_link", "slm_attachment_lure",
  "slm_html_smuggling", "slm_trusted_site_abuse",

  // slm — ATO (5)
  "slm_ato_style", "slm_ato_delegation", "slm_ato_lateral",
  "slm_ato_forwarding", "slm_ato_send_time",

  // slm — data exfiltration (3)
  "slm_data_exfil", "slm_sensitive_data", "slm_exfil_staging",

  // slm — spam / graymail (5)
  "slm_cold_outreach", "slm_unsolicited_newsletter", "slm_spam",
  "slm_graymail_marketing", "slm_graymail_notification",

  // slm — conversation-aware (9)
  "slm_bank_change", "slm_financial_esc", "slm_intent_action",
  "slm_topic_drift", "slm_urgency_inject", "slm_pretext",
  "slm_style_shift", "slm_perplexity", "slm_thread_hijack",

  // slm — AI / evasion (2)
  "slm_ai_generated", "slm_multilingual_obfuscation",

  // slm — cross-signal + trust (7)
  "slm_reasoned_phish", "slm_auth_full_pass", "slm_internal_auth",
  "slm_reply_to_match", "slm_thread_consistent", "slm_known_sender",
  "slm_smime_signed",

  // stats_db — behavioral baselines (46)
  "sdb_first_time_sender", "sdb_first_time_pair", "sdb_off_hours",
  "sdb_sender_burst", "sdb_domain_first_seen", "sdb_domain_recent",
  "sdb_daily_spike", "sdb_silence_burst", "sdb_lookalike", "sdb_freemail_corp",
  "sdb_mass_bcc", "sdb_size_anomaly", "sdb_link_density", "sdb_dormant_reactivation",
  "sdb_sender_local_entropy", "sdb_reply_to_mismatch", "sdb_payloadless_financial",
  "sdb_recipient_fanout_spike", "sdb_phone_number_lure", "sdb_body_brevity_urgency",
  "sdb_volume_zscore", "sdb_domain_age_risk", "sdb_newly_registered",
  // previously unmapped E3 signals
  "sdb_cadence_shift", "sdb_domain_surge", "sdb_hourly_deviation",
  "sdb_send_rate_change", "sdb_weekend_spike", "sdb_schedule_deviation",
  "sdb_domain_volume_trend", "sdb_pair_freq_deviation", "sdb_recipient_count_anomaly",
  "sdb_attachment_rate_anomaly", "sdb_bulk_individual_shift",
  // new E3 behavioral signals
  "sdb_style_deviation", "sdb_multi_stage", "sdb_changepoint",
  "sdb_report_velocity", "sdb_thread_inject", "sdb_thread_hijack",
  "sdb_thread_velocity",

  // graph_db — relationship & topology (16)
  "g_trust_low", "g_first_time_external", "g_direction_reversal",
  "g_new_contact_burst", "g_vip_mismatch", "g_compromised_spray",
  "g_dormant_reactivation", "g_edge_acceleration", "g_first_time_pair",
  // previously unmapped E4 signals
  "g_freq_weight_low", "g_no_reciprocity", "g_young_relationship",
  "g_trust_decay", "g_pattern_break", "g_sudden_burst", "g_display_name_reuse",
  // new E4 topology signals
  "g_hierarchy_violation", "g_clique_penetration", "g_dept_boundary",
  "g_org_flow_reversal", "g_rel_content_anomaly", "g_rel_tempo_break",
  "g_shadow_hierarchy",

  // url_scanner (14)
  "url_numeric_ip", "url_idn_homograph", "url_excessive_subdomains",
  "url_dga_like", "url_suspicious_tld", "url_shortener",
  "url_redirect_long", "url_landing_cred_form", "url_landing_mismatch",
  "url_blocklist_hit", "url_obfuscated_js",
  // previously unmapped E5 signals
  "url_user_password", "url_data_uri", "url_base64_payload",
  "url_path_length", "url_redirect_domain_hops", "url_hidden_iframe",
  // new E5 behavioral signals
  "url_behavioral_novelty", "url_sender_mismatch", "url_campaign_pattern",

  // attachment (6)
  "att_dangerous",
  "att_sender_novelty", "att_entropy", "att_rel_anomaly",
  "att_macro_context", "att_type_mismatch",

  // visual (4)
  "vis_cred_form",
  "vis_brand_behavioral", "vis_harvesting_ux", "vis_internal_mimic",

  // specialized_ml (16)
  "sml_mixed_script", "sml_confusable", "sml_idn_lookalike",
  "sml_header_order", "sml_unusual_combo", "sml_received_forged",
  "sml_message_id_anom", "sml_base64_obf", "sml_qp_abuse",
  "sml_exotic_charset", "sml_mime_deep", "sml_nested_mp",
  // previously unmapped E9 signal
  "sml_content_type_mismatch",
  // new E9 behavioral signals
  "sml_client_drift", "sml_infra_drift", "sml_persona_inconsist",
];

// Maps a signal name (engine-independent substring) to feature index.
// Order matters — first match wins.
const PATTERNS = [
  // rspamd
  [/^rspamd\..*spf_fail/i, "rspamd_spf_fail"],
  [/^rspamd\..*dmarc/i, "rspamd_dmarc_reject"],
  [/^rspamd\.action_/i, "rspamd_action"],

  // slm — credential theft
  [/^slm\.credential_harvesting/i, "slm_credential"],
  [/^slm\.qr_code_phishing/i, "slm_qr_phishing"],
  [/^slm\.consent_phishing_oauth/i, "slm_consent_oauth"],
  [/^slm\.device_code_phishing/i, "slm_device_code"],
  [/^slm\.password_reset_lure/i, "slm_password_reset"],
  [/^slm\.mfa_fatigue_priming/i, "slm_mfa_fatigue"],

  // slm — BEC / financial
  [/^slm\.financial_request/i, "slm_financial"],
  [/^slm\.payroll_diversion/i, "slm_payroll_diversion"],
  [/^slm\.invoice_fraud/i, "slm_invoice_fraud"],
  [/^slm\.gift_card_solicitation/i, "slm_gift_card"],

  // slm — impersonation
  [/^slm\.executive_impersonation/i, "slm_exec_impersonation"],
  [/^slm\.impersonation_attempt/i, "slm_impersonation"],
  [/^slm\.brand_impersonation/i, "slm_brand_impersonation"],
  [/^slm\.lookalike_domain/i, "slm_lookalike_domain"],
  [/^slm\.display_name_spoofing/i, "slm_display_name_spoof"],
  [/^slm\.reply_to_mismatch/i, "slm_reply_to_mismatch"],
  [/^slm\.internal_domain_spoofing/i, "slm_internal_domain_spoof"],

  // slm — social engineering
  [/^slm\.urgency_language/i, "slm_urgency"],
  [/^slm\.emotional_manipulation/i, "slm_emotional"],
  [/^slm\.authority_exploitation/i, "slm_authority"],
  [/^slm\.social_engineering/i, "slm_social_engineering"],
  [/^slm\.scarcity_pressure/i, "slm_scarcity"],
  [/^slm\.reciprocity_manipulation/i, "slm_reciprocity"],
  [/^slm\.callback_phishing_toad/i, "slm_callback_toad"],
  [/^slm\.deepfake_reference/i, "slm_deepfake_ref"],

  // slm — malware / payload
  [/^slm\.malware_delivery/i, "slm_malware"],
  [/^slm\.suspicious_link/i, "slm_suspicious_link"],
  [/^slm\.attachment_lure/i, "slm_attachment_lure"],
  [/^slm\.html_smuggling_indicator/i, "slm_html_smuggling"],
  [/^slm\.trusted_site_abuse/i, "slm_trusted_site_abuse"],

  // slm — ATO
  [/^slm\.ato_style_anomaly/i, "slm_ato_style"],
  [/^slm\.ato_delegation_request/i, "slm_ato_delegation"],
  [/^slm\.ato_lateral_phishing/i, "slm_ato_lateral"],
  [/^slm\.ato_forwarding_rule/i, "slm_ato_forwarding"],
  [/^slm\.ato_send_time_anomaly/i, "slm_ato_send_time"],

  // slm — data exfiltration
  [/^slm\.data_exfiltration_request/i, "slm_data_exfil"],
  [/^slm\.sensitive_data_exposure/i, "slm_sensitive_data"],
  [/^slm\.exfil_attachment_staging/i, "slm_exfil_staging"],

  // slm — spam / graymail
  [/^slm\.cold_outreach/i, "slm_cold_outreach"],
  [/^slm\.unsolicited_newsletter/i, "slm_unsolicited_newsletter"],
  [/^slm\.spam_content/i, "slm_spam"],
  [/^slm\.graymail_marketing/i, "slm_graymail_marketing"],
  [/^slm\.graymail_notification/i, "slm_graymail_notification"],

  // slm — conversation-aware
  [/^slm\.bank_detail_change/i, "slm_bank_change"],
  [/^slm\.financial_escalation/i, "slm_financial_esc"],
  [/^slm\.intent_action_request/i, "slm_intent_action"],
  [/^slm\.topic_drift_financial/i, "slm_topic_drift"],
  [/^slm\.urgency_injection/i, "slm_urgency_inject"],
  [/^slm\.pretexting_detection/i, "slm_pretext"],
  [/^slm\.sender_style_shift/i, "slm_style_shift"],
  [/^slm\.perplexity_deviation/i, "slm_perplexity"],
  [/^slm\.thread_hijacking/i, "slm_thread_hijack"],

  // slm — AI / evasion
  [/^slm\.ai_generated_content/i, "slm_ai_generated"],
  [/^slm\.multilingual_obfuscation/i, "slm_multilingual_obfuscation"],

  // slm — cross-signal + trust
  [/^slm\.rspamd_reasoned/i, "slm_reasoned_phish"],
  [/^slm\.auth_full_pass/i, "slm_auth_full_pass"],
  [/^slm\.internal_authenticated/i, "slm_internal_auth"],
  [/^slm\.reply_to_matches_from/i, "slm_reply_to_match"],
  [/^slm\.thread_context_consistent/i, "slm_thread_consistent"],
  [/^slm\.known_sender_pattern/i, "slm_known_sender"],
  [/^slm\.smime_signed/i, "slm_smime_signed"],

  // stats_db — order matters: more specific patterns before general ones
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
  [/stats_db\.newly_registered_domain/i, "sdb_newly_registered"],
  [/stats_db\.sender_domain_age_risk/i, "sdb_domain_age_risk"],
  // previously unmapped E3 signals
  [/stats_db\.communication_cadence_shift/i, "sdb_cadence_shift"],
  [/stats_db\.new_domain_surge/i, "sdb_domain_surge"],
  [/stats_db\.hourly_deviation/i, "sdb_hourly_deviation"],
  [/stats_db\.send_rate_change/i, "sdb_send_rate_change"],
  [/stats_db\.weekend_activity_spike/i, "sdb_weekend_spike"],
  [/stats_db\.schedule_deviation/i, "sdb_schedule_deviation"],
  [/stats_db\.domain_email_volume_trend/i, "sdb_domain_volume_trend"],
  [/stats_db\.pair_frequency_deviation/i, "sdb_pair_freq_deviation"],
  [/stats_db\.recipient_count_anomaly/i, "sdb_recipient_count_anomaly"],
  [/stats_db\.attachment_rate_anomaly/i, "sdb_attachment_rate_anomaly"],
  [/stats_db\.bulk_vs_individual/i, "sdb_bulk_individual_shift"],
  // new E3 behavioral signals
  [/stats_db\.sender_style_deviation/i, "sdb_style_deviation"],
  [/stats_db\.multi_stage_ramp/i, "sdb_multi_stage"],
  [/stats_db\.behavior_changepoint/i, "sdb_changepoint"],
  [/stats_db\.user_report_velocity/i, "sdb_report_velocity"],
  [/stats_db\.thread_participant_injection/i, "sdb_thread_inject"],
  [/stats_db\.thread_reply_to_hijack/i, "sdb_thread_hijack"],
  [/stats_db\.thread_velocity_spike/i, "sdb_thread_velocity"],

  // graph_db
  [/graph_db\.trust_score_low/i, "g_trust_low"],
  [/graph_db\.first_time_external/i, "g_first_time_external"],
  [/graph_db\.direction_reversal/i, "g_direction_reversal"],
  [/graph_db\.new_contact_burst/i, "g_new_contact_burst"],
  [/graph_db\.(vip|executive)/i, "g_vip_mismatch"],
  [/graph_db\.compromised_account_spray/i, "g_compromised_spray"],
  [/graph_db\.(re_emergence|dormant_reactivation)/i, "g_dormant_reactivation"],
  [/graph_db\.edge_frequency/i, "g_edge_acceleration"],
  [/graph_db\.first_time_pair/i, "g_first_time_pair"],
  // previously unmapped E4 signals
  [/graph_db\.frequency_weight_low/i, "g_freq_weight_low"],
  [/graph_db\.no_reciprocity/i, "g_no_reciprocity"],
  [/graph_db\.young_relationship/i, "g_young_relationship"],
  [/graph_db\.trust_decay_dormant/i, "g_trust_decay"],
  [/graph_db\.pattern_break/i, "g_pattern_break"],
  [/graph_db\.sudden_new_contact_burst/i, "g_sudden_burst"],
  [/graph_db\.display_name_reuse/i, "g_display_name_reuse"],
  // new E4 topology signals
  [/graph_db\.hierarchy_violation/i, "g_hierarchy_violation"],
  [/graph_db\.clique_penetration/i, "g_clique_penetration"],
  [/graph_db\.department_boundary_cross/i, "g_dept_boundary"],
  [/graph_db\.org_flow_reversal/i, "g_org_flow_reversal"],
  [/graph_db\.relationship_content_anomaly/i, "g_rel_content_anomaly"],
  [/graph_db\.relationship_tempo_break/i, "g_rel_tempo_break"],
  [/graph_db\.shadow_hierarchy_deviation/i, "g_shadow_hierarchy"],

  // url_scanner
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
  // previously unmapped E5 signals
  [/url_scanner\.url_user_password/i, "url_user_password"],
  [/url_scanner\.url_data_uri/i, "url_data_uri"],
  [/url_scanner\.url_base64_payload/i, "url_base64_payload"],
  [/url_scanner\.url_abnormal_path/i, "url_path_length"],
  [/url_scanner\.redirect_domain_hops/i, "url_redirect_domain_hops"],
  [/url_scanner\.landing_hidden_iframe/i, "url_hidden_iframe"],
  // new E5 behavioral signals
  [/url_scanner\.url_behavioral_novelty/i, "url_behavioral_novelty"],
  [/url_scanner\.url_sender_url_mismatch/i, "url_sender_mismatch"],
  [/url_scanner\.url_campaign_pattern/i, "url_campaign_pattern"],

  // attachment
  [/attachment\.dangerous_extension/i, "att_dangerous"],
  [/attachment\.attachment_sender_novelty/i, "att_sender_novelty"],
  [/attachment\.attachment_entropy_anomaly/i, "att_entropy"],
  [/attachment\.attachment_relationship_anomaly/i, "att_rel_anomaly"],
  [/attachment\.attachment_macro_context/i, "att_macro_context"],
  [/attachment\.attachment_type_mismatch/i, "att_type_mismatch"],

  // visual
  [/visual\.credential_form/i, "vis_cred_form"],
  [/visual\.visual_brand_behavioral/i, "vis_brand_behavioral"],
  [/visual\.visual_harvesting_ux/i, "vis_harvesting_ux"],
  [/visual\.visual_internal_tool_mimic/i, "vis_internal_mimic"],

  // specialized_ml
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
  [/specialized_ml\.content_type_mismatch/i, "sml_content_type_mismatch"],
  // new E9 behavioral signals
  [/specialized_ml\.header_client_drift/i, "sml_client_drift"],
  [/specialized_ml\.header_infra_fingerprint/i, "sml_infra_drift"],
  [/specialized_ml\.header_persona_inconsistency/i, "sml_persona_inconsist"],
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
