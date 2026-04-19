// E3 Stats DB unit tests — exercise extractSignals() with hand-built
// contexts (no MySQL needed). Integration of the DB layer is covered by
// the eval framework against a live MariaDB in the smoke path.
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSignals, editDist, senderDomain, receivedAt, applyWeight,
} from "../services/e3_stats_db/index.js";

function email(o = {}) {
  return { org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [], ...o };
}

function ctx(overrides = {}) {
  return {
    orgId: "o", sender: "a@b.com", domain: "b.com", recipient: "c@d.com",
    ts: new Date("2026-04-17T12:00:00Z"), // noon UTC, weekday
    senderHist: null, pairHist: null, domainRow: null,
    senderDaily: [], senderHourly: [], senderAgg: 0,
    orgInternalDomains: [], domainRecent: null, rdapData: null,
    ...overrides,
  };
}

test("editDist: returns correct distances below cap", () => {
  assert.equal(editDist("abc", "abc"), 0);
  assert.equal(editDist("abc", "abd"), 1);
  assert.equal(editDist("abc", "axc"), 1);
  assert.equal(editDist("login-microsft.com", "login-microsoft.com"), 1);
});

test("editDist: caps when strings differ widely", () => {
  assert.ok(editDist("abc", "xyzmn") > 2);
});

test("senderDomain: lowercases and strips to domain", () => {
  assert.equal(senderDomain({ sender: "User@Example.COM" }), "example.com");
  assert.equal(senderDomain({ sender: "no-at-sign" }), "");
});

test("receivedAt: parses ISO strings, falls back to now on invalid", () => {
  assert.equal(
    receivedAt({ received_at: "2026-01-01T00:00:00Z" }).toISOString(),
    "2026-01-01T00:00:00.000Z",
  );
  const now = receivedAt({ received_at: "garbage" });
  assert.ok(now instanceof Date);
});

test("applyWeight: scales scores; weight>=1 returns inputs unchanged", () => {
  const s = [{ engine: "x", signal: "y", score: 2, detail: {} }];
  assert.equal(applyWeight(s, 1)[0].score, 2);
  assert.equal(applyWeight(s, 0.5)[0].score, 1);
  assert.equal(applyWeight(s, 0)[0].score, 0);
});

test("first_time_sender fires when senderHist.n = 0", () => {
  const s = extractSignals(email(), ctx({ senderHist: { n: 0 } }));
  assert.ok(s.some((x) => x.signal === "first_time_sender"));
});

test("first_time_sender does NOT fire when sender has history", () => {
  const s = extractSignals(email(), ctx({ senderHist: { n: 5 } }));
  assert.equal(s.some((x) => x.signal === "first_time_sender"), false);
});

test("first_time_pair fires when pairHist is null", () => {
  const s = extractSignals(email(), ctx({ pairHist: null }));
  assert.ok(s.some((x) => x.signal === "first_time_pair"));
});

test("first_time_pair does NOT fire when pair exists", () => {
  const s = extractSignals(email(), ctx({ pairHist: { total_count: 1 } }));
  assert.equal(s.some((x) => x.signal === "first_time_pair"), false);
});

test("domain_first_seen fires when domainRow is null", () => {
  const s = extractSignals(email(), ctx({ domainRow: null }));
  assert.ok(s.some((x) => x.signal === "domain_first_seen"));
});

test("domain_first_seen_recent fires when domain <48h old", () => {
  const twelveHoursAgo = new Date(Date.now() - 12 * 3600 * 1000);
  const s = extractSignals(email(), ctx({ domainRow: { first_seen: twelveHoursAgo } }));
  assert.ok(s.some((x) => x.signal === "domain_first_seen_recent"));
});

test("domain_first_seen_recent does NOT fire when domain >48h old", () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 86400 * 1000);
  const s = extractSignals(email(), ctx({ domainRow: { first_seen: tenDaysAgo } }));
  assert.equal(s.some((x) => x.signal === "domain_first_seen_recent"), false);
});

test("off_hours_email fires outside business hours", () => {
  const lateNight = new Date("2026-04-17T23:00:00Z");
  const s = extractSignals(email(), ctx({ ts: lateNight }));
  assert.ok(s.some((x) => x.signal === "off_hours_email"));
});

test("off_hours_email respects org business_hours override", () => {
  const noon = new Date("2026-04-17T12:00:00Z");
  const s = extractSignals(email(), ctx({ ts: noon }),
    { business_hours_start: 18, business_hours_end: 23 });
  assert.ok(s.some((x) => x.signal === "off_hours_email"));
});

test("sender_burst fires when hourly count exceeds threshold", () => {
  const s = extractSignals(email(), ctx({ senderAgg: 50 }));
  assert.ok(s.some((x) => x.signal === "sender_burst"));
});

test("sender_burst does NOT fire under threshold", () => {
  const s = extractSignals(email(), ctx({ senderAgg: 2 }));
  assert.equal(s.some((x) => x.signal === "sender_burst"), false);
});

test("mass_bcc_detection fires when recipients > 10", () => {
  const many = Array.from({ length: 15 }, (_, i) => `u${i}@x.com`);
  const s = extractSignals(email({ recipients: many }), ctx());
  const m = s.find((x) => x.signal === "mass_bcc_detection");
  assert.ok(m);
  assert.equal(m.detail.recipient_count, 15);
});

test("lookalike_domain fires for near-miss against known internal domain", () => {
  const s = extractSignals(email({ sender: "attacker@acmecrp.com" }),
    ctx({ domain: "acmecrp.com", orgInternalDomains: ["acmecorp.com"] }));
  const lk = s.find((x) => x.signal === "lookalike_domain");
  assert.ok(lk);
  assert.equal(lk.detail.similar_to, "acmecorp.com");
});

test("lookalike_domain does NOT fire for exact match", () => {
  const s = extractSignals(email({ sender: "alice@acmecorp.com" }),
    ctx({ domain: "acmecorp.com", orgInternalDomains: ["acmecorp.com"] }));
  assert.equal(s.some((x) => x.signal === "lookalike_domain"), false);
});

test("freemail_to_corp fires when freemail sender targets corp recipient", () => {
  const s = extractSignals(
    email({ sender: "scammer@gmail.com", recipients: ["alice@acmecorp.com"] }),
    ctx({ domain: "gmail.com" }),
  );
  assert.ok(s.some((x) => x.signal === "freemail_to_corp"));
});

test("dormant_sender_reactivation fires when last_seen > 30 days ago", () => {
  const oldLastSeen = new Date(Date.now() - 40 * 86400 * 1000);
  const s = extractSignals(email(), ctx({
    senderHist: { n: 10, last_seen: oldLastSeen },
  }));
  assert.ok(s.some((x) => x.signal === "dormant_sender_reactivation"));
});

test("weekend_activity_spike fires on weekend for sender who never weekends", () => {
  const sundayNoon = new Date("2026-04-19T12:00:00Z"); // Sunday
  const s = extractSignals(email(), ctx({
    ts: sundayNoon,
    senderHist: { n: 20 },
    senderHourly: [
      { hour_of_day: 10, day_of_week: 1, email_count: 5 },
      { hour_of_day: 11, day_of_week: 2, email_count: 8 },
      { hour_of_day: 12, day_of_week: 3, email_count: 7 },
    ],
  }));
  assert.ok(s.some((x) => x.signal === "weekend_activity_spike"));
});

test("daily_count_spike fires when today exceeds 3× weekly average", () => {
  const today = new Date("2026-04-17T12:00:00Z");
  const s = extractSignals(email(), ctx({
    ts: today,
    senderDaily: [
      { date: "2026-04-17", email_count: 30 },
      { date: "2026-04-16", email_count: 2 },
      { date: "2026-04-15", email_count: 3 },
      { date: "2026-04-14", email_count: 2 },
    ],
  }));
  assert.ok(s.some((x) => x.signal === "daily_count_spike"));
});

test("size_distribution_anomaly fires when body 3× larger than average", () => {
  const bigBody = "x".repeat(10_000);
  const s = extractSignals(email({ body_text: bigBody }), ctx({
    senderHist: { n: 20, avg_size: 500, avg_links: 0, avg_attach: 0 },
  }));
  assert.ok(s.some((x) => x.signal === "size_distribution_anomaly"));
});

// ── New signals tests ─────────────────────────────────────────────────

test("daily_count_spike uses MAD-based z-score and fires on spike", () => {
  const s = extractSignals(email(), ctx({
    senderDaily: [
      { date: "2026-04-17", email_count: 50 },
      { date: "2026-04-16", email_count: 2 },
      { date: "2026-04-15", email_count: 3 },
      { date: "2026-04-14", email_count: 2 },
      { date: "2026-04-13", email_count: 3 },
    ],
  }));
  const spike = s.find((x) => x.signal === "daily_count_spike");
  assert.ok(spike, "daily_count_spike should fire");
  assert.equal(spike.score, 3.75);
  assert.ok(spike.detail.modified_z > 3.5);
});

test("daily_count_spike does NOT fire when counts are uniform", () => {
  const s = extractSignals(email(), ctx({
    senderDaily: [
      { date: "2026-04-17", email_count: 3 },
      { date: "2026-04-16", email_count: 3 },
      { date: "2026-04-15", email_count: 3 },
    ],
  }));
  assert.equal(s.some((x) => x.signal === "daily_count_spike"), false);
});

test("sender_local_entropy fires for high-entropy local-part", () => {
  // Long random-looking address with many distinct chars → high Shannon entropy > 4.0
  const addr = "x9k2m4p7q1w3z8r6t5u0v@evil.com";
  const s = extractSignals(
    email({ sender: addr }),
    ctx({ sender: addr, domain: "evil.com" }),
  );
  assert.ok(s.some((x) => x.signal === "sender_local_entropy"));
});

test("sender_local_entropy does NOT fire for normal local-part", () => {
  const s = extractSignals(
    email({ sender: "john.smith@company.com" }),
    ctx({ sender: "john.smith@company.com", domain: "company.com" }),
  );
  assert.equal(s.some((x) => x.signal === "sender_local_entropy"), false);
});

test("reply_to_domain_mismatch fires when Reply-To domain differs", () => {
  const s = extractSignals(
    email({ sender: "ceo@legit.com", headers: { reply_to: "ceo@evil.com" } }),
    ctx({ sender: "ceo@legit.com", domain: "legit.com" }),
  );
  const m = s.find((x) => x.signal === "reply_to_domain_mismatch");
  assert.ok(m);
  assert.equal(m.detail.reply_to_domain, "evil.com");
});

test("reply_to_domain_mismatch does NOT fire when domains match", () => {
  const s = extractSignals(
    email({ sender: "ceo@legit.com", headers: { reply_to: "ceo@legit.com" } }),
    ctx({ sender: "ceo@legit.com", domain: "legit.com" }),
  );
  assert.equal(s.some((x) => x.signal === "reply_to_domain_mismatch"), false);
});

test("payloadless_financial fires with financial keywords and no links/attachments", () => {
  const s = extractSignals(
    email({ body_text: "Please process the wire transfer immediately", attachments: [] }),
    ctx(),
  );
  assert.ok(s.some((x) => x.signal === "payloadless_financial"));
});

test("payloadless_financial does NOT fire when URLs present", () => {
  const s = extractSignals(
    email({ body_text: "Invoice at https://example.com/pay", attachments: [] }),
    ctx(),
  );
  assert.equal(s.some((x) => x.signal === "payloadless_financial"), false);
});

test("recipient_fanout_spike fires when 24h fanout exceeds 3× daily median", () => {
  const s = extractSignals(email(), ctx({
    recipientFanout24h: 30,
    senderDaily: [
      { date: "2026-04-17", email_count: 3 },
      { date: "2026-04-16", email_count: 2 },
      { date: "2026-04-15", email_count: 3 },
    ],
  }));
  assert.ok(s.some((x) => x.signal === "recipient_fanout_spike"));
});

test("recipient_fanout_spike does NOT fire when fanout is normal", () => {
  const s = extractSignals(email(), ctx({
    recipientFanout24h: 2,
    senderDaily: [
      { date: "2026-04-17", email_count: 3 },
      { date: "2026-04-16", email_count: 2 },
      { date: "2026-04-15", email_count: 3 },
    ],
  }));
  assert.equal(s.some((x) => x.signal === "recipient_fanout_spike"), false);
});

test("phone_number_lure fires with phone number + urgency, no URLs", () => {
  const s = extractSignals(
    email({ body_text: "Call 555-123-4567 immediately. This is urgent." }),
    ctx(),
  );
  assert.ok(s.some((x) => x.signal === "phone_number_lure"));
});

test("phone_number_lure does NOT fire when URLs present", () => {
  const s = extractSignals(
    email({ body_text: "Call 555-123-4567 urgent https://example.com" }),
    ctx(),
  );
  assert.equal(s.some((x) => x.signal === "phone_number_lure"), false);
});

test("body_brevity_with_urgency fires for short body with urgency", () => {
  const s = extractSignals(
    email({ body_text: "Act now or your account will be suspended." }),
    ctx(),
  );
  assert.ok(s.some((x) => x.signal === "body_brevity_with_urgency"));
});

test("body_brevity_with_urgency does NOT fire for long body", () => {
  const longBody = "Act now. " + "x".repeat(200);
  const s = extractSignals(email({ body_text: longBody }), ctx());
  assert.equal(s.some((x) => x.signal === "body_brevity_with_urgency"), false);
});

test("volume_zscore_anomaly fires when z-score > 3.0", () => {
  // Need extreme spike relative to baseline for population z-score > 3.0
  const s = extractSignals(email(), ctx({
    senderDaily: [
      { date: "2026-04-17", email_count: 200 },
      { date: "2026-04-16", email_count: 3 },
      { date: "2026-04-15", email_count: 2 },
      { date: "2026-04-14", email_count: 3 },
      { date: "2026-04-13", email_count: 2 },
      { date: "2026-04-12", email_count: 3 },
      { date: "2026-04-11", email_count: 2 },
    ],
  }));
  const v = s.find((x) => x.signal === "volume_zscore_anomaly");
  assert.ok(v);
  assert.ok(v.detail.z_score > 3.0);
});

test("volume_zscore_anomaly does NOT fire for stable volumes", () => {
  const s = extractSignals(email(), ctx({
    senderDaily: [
      { date: "2026-04-17", email_count: 5 },
      { date: "2026-04-16", email_count: 4 },
      { date: "2026-04-15", email_count: 5 },
      { date: "2026-04-14", email_count: 4 },
      { date: "2026-04-13", email_count: 5 },
    ],
  }));
  assert.equal(s.some((x) => x.signal === "volume_zscore_anomaly"), false);
});

test("sender_domain_age_risk fires when domain < 7 days old (org fallback)", () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 86400 * 1000);
  const s = extractSignals(email(), ctx({
    domainRow: { first_seen: twoDaysAgo },
  }));
  const m = s.find((x) => x.signal === "sender_domain_age_risk");
  assert.ok(m);
  assert.equal(m.detail.source, "org_first_seen");
});

test("sender_domain_age_risk does NOT fire when domain > 7 days old (org fallback)", () => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000);
  const s = extractSignals(email(), ctx({
    domainRow: { first_seen: thirtyDaysAgo },
  }));
  assert.equal(s.some((x) => x.signal === "sender_domain_age_risk"), false);
});

// ── RDAP-based domain age tests ─────────────────────────────────────────

test("newly_registered_domain fires when RDAP registration < 30 days", () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 86400 * 1000);
  const s = extractSignals(email(), ctx({
    rdapData: { registration_date: tenDaysAgo.toISOString(), rdap_status: "ok" },
  }));
  const m = s.find((x) => x.signal === "newly_registered_domain");
  assert.ok(m, "newly_registered_domain should fire");
  assert.equal(m.score, 3.0);
  assert.equal(m.detail.source, "rdap");
});

test("sender_domain_age_risk fires when RDAP registration 30–365 days", () => {
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400 * 1000);
  const s = extractSignals(email(), ctx({
    rdapData: { registration_date: sixMonthsAgo.toISOString(), rdap_status: "ok" },
  }));
  const m = s.find((x) => x.signal === "sender_domain_age_risk");
  assert.ok(m, "sender_domain_age_risk should fire for 30-365d RDAP");
  assert.equal(m.score, 1.5);
  assert.equal(m.detail.source, "rdap");
});

test("no domain age signal when RDAP registration > 365 days", () => {
  const twoYearsAgo = new Date(Date.now() - 730 * 86400 * 1000);
  const s = extractSignals(email(), ctx({
    rdapData: { registration_date: twoYearsAgo.toISOString(), rdap_status: "ok" },
  }));
  assert.equal(s.some((x) => x.signal === "newly_registered_domain"), false);
  assert.equal(s.some((x) => x.signal === "sender_domain_age_risk"), false);
});

test("falls back to org_first_seen when rdapData is null", () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 86400 * 1000);
  const s = extractSignals(email(), ctx({
    rdapData: null,
    domainRow: { first_seen: threeDaysAgo },
  }));
  const m = s.find((x) => x.signal === "sender_domain_age_risk");
  assert.ok(m, "should fall back to org_first_seen");
  assert.equal(m.detail.source, "org_first_seen");
});

test("falls back to org_first_seen when rdap_status is error", () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 86400 * 1000);
  const s = extractSignals(email(), ctx({
    rdapData: { registration_date: null, rdap_status: "error" },
    domainRow: { first_seen: threeDaysAgo },
  }));
  const m = s.find((x) => x.signal === "sender_domain_age_risk");
  assert.ok(m, "should fall back when RDAP errored");
  assert.equal(m.detail.source, "org_first_seen");
});

// ── Sender fingerprint: sender_style_deviation ─────────────────────────

test("sender_style_deviation fires when 3+ fingerprint dimensions deviate", () => {
  // Deviation 1: body length far from avg (> 3× stddev)
  // Deviation 2: subject length far from avg (> 2× avg)
  // Deviation 3: link count jumps (avg < 0.5, current >= 3)
  // Deviation 4: attachment count jumps (avg < 0.1, current >= 1)
  const s = extractSignals(
    email({
      body_text: "x".repeat(5000) + " https://a.com https://b.com https://c.com",
      subject: "x".repeat(200),
      attachments: [{ name: "malware.zip" }],
    }),
    ctx({
      fingerprint: {
        sample_count: 15,
        avg_body_length: 100,
        stddev_body_length: 50,
        avg_subject_length: 10,
        avg_link_count: 0.1,
        avg_attachment_count: 0.0,
      },
    }),
  );
  const m = s.find((x) => x.signal === "sender_style_deviation");
  assert.ok(m, "sender_style_deviation should fire");
  assert.equal(m.score, 2.25);
  assert.ok(m.detail.deviations >= 3);
});

test("sender_style_deviation does NOT fire when fewer than 3 dimensions deviate", () => {
  // Only body length deviates; subject, links, attachments are normal
  const s = extractSignals(
    email({ body_text: "x".repeat(5000), subject: "Hi", attachments: [] }),
    ctx({
      fingerprint: {
        sample_count: 15,
        avg_body_length: 100,
        stddev_body_length: 50,
        avg_subject_length: 5,
        avg_link_count: 0.1,
        avg_attachment_count: 0.0,
      },
    }),
  );
  assert.equal(s.some((x) => x.signal === "sender_style_deviation"), false);
});

test("sender_style_deviation does NOT fire when sample_count < 10", () => {
  const s = extractSignals(
    email({
      body_text: "x".repeat(5000) + " https://a.com https://b.com https://c.com",
      subject: "x".repeat(200),
      attachments: [{ name: "malware.zip" }],
    }),
    ctx({
      fingerprint: {
        sample_count: 5,
        avg_body_length: 100,
        stddev_body_length: 50,
        avg_subject_length: 10,
        avg_link_count: 0.1,
        avg_attachment_count: 0.0,
      },
    }),
  );
  assert.equal(s.some((x) => x.signal === "sender_style_deviation"), false);
});

// ── Thread structural: thread_participant_injection ─────────────────────

test("thread_participant_injection fires when new sender joins existing thread", () => {
  const s = extractSignals(
    email({
      sender: "attacker@evil.com",
      thread: [
        { sender: "alice@corp.com", ts: "2026-04-17T09:00:00Z" },
        { sender: "bob@corp.com", ts: "2026-04-17T10:00:00Z" },
      ],
    }),
    ctx({ sender: "attacker@evil.com", domain: "evil.com" }),
  );
  const m = s.find((x) => x.signal === "thread_participant_injection");
  assert.ok(m, "thread_participant_injection should fire");
  assert.equal(m.score, 2.5);
  assert.equal(m.detail.new_sender, "attacker@evil.com");
});

test("thread_participant_injection does NOT fire when sender already in thread", () => {
  const s = extractSignals(
    email({
      thread: [
        { sender: "a@b.com", ts: "2026-04-17T09:00:00Z" },
        { sender: "bob@corp.com", ts: "2026-04-17T10:00:00Z" },
      ],
    }),
    ctx(),
  );
  assert.equal(s.some((x) => x.signal === "thread_participant_injection"), false);
});

test("thread_participant_injection does NOT fire when thread is empty", () => {
  const s = extractSignals(email({ thread: [] }), ctx());
  assert.equal(s.some((x) => x.signal === "thread_participant_injection"), false);
});

// ── Thread structural: thread_reply_to_hijack ───────────────────────────

test("thread_reply_to_hijack fires when Reply-To domain differs from thread domains", () => {
  const s = extractSignals(
    email({
      headers: { reply_to: "ceo@attacker.com" },
      thread: [
        { sender: "alice@corp.com", ts: "2026-04-17T09:00:00Z" },
        { sender: "bob@corp.com", ts: "2026-04-17T10:00:00Z" },
      ],
    }),
    ctx({ domain: "b.com" }),
  );
  const m = s.find((x) => x.signal === "thread_reply_to_hijack");
  assert.ok(m, "thread_reply_to_hijack should fire");
  assert.equal(m.score, 3.5);
  assert.equal(m.detail.reply_to_domain, "attacker.com");
  assert.ok(m.detail.thread_domains.includes("corp.com"));
});

test("thread_reply_to_hijack does NOT fire when Reply-To domain matches a thread domain", () => {
  const s = extractSignals(
    email({
      headers: { reply_to: "alias@corp.com" },
      thread: [
        { sender: "alice@corp.com", ts: "2026-04-17T09:00:00Z" },
        { sender: "bob@corp.com", ts: "2026-04-17T10:00:00Z" },
      ],
    }),
    ctx({ domain: "b.com" }),
  );
  assert.equal(s.some((x) => x.signal === "thread_reply_to_hijack"), false);
});

test("thread_reply_to_hijack does NOT fire without Reply-To header", () => {
  const s = extractSignals(
    email({
      headers: {},
      thread: [
        { sender: "alice@corp.com", ts: "2026-04-17T09:00:00Z" },
        { sender: "bob@corp.com", ts: "2026-04-17T10:00:00Z" },
      ],
    }),
    ctx({ domain: "b.com" }),
  );
  assert.equal(s.some((x) => x.signal === "thread_reply_to_hijack"), false);
});

// ── Thread structural: thread_velocity_spike ────────────────────────────

test("thread_velocity_spike fires when reply comes within 1h after 24h+ avg gap", () => {
  // Build a thread with messages spaced >24h apart, and the last message
  // very recent (within 1h of now) so lastGap = Date.now() - last_ts < 1h.
  const now = Date.now();
  const s = extractSignals(
    email({
      thread: [
        { sender: "alice@corp.com", ts: new Date(now - 5 * 86400000).toISOString() },
        { sender: "bob@corp.com", ts: new Date(now - 3 * 86400000).toISOString() },
        { sender: "alice@corp.com", ts: new Date(now - 1 * 86400000).toISOString() },
        { sender: "bob@corp.com", ts: new Date(now - 600000).toISOString() }, // 10 min ago
      ],
    }),
    ctx(),
  );
  const m = s.find((x) => x.signal === "thread_velocity_spike");
  assert.ok(m, "thread_velocity_spike should fire");
  assert.equal(m.score, 1.8);
  assert.ok(m.detail.avg_gap_hours >= 24);
  assert.ok(m.detail.last_gap_hours < 1);
});

test("thread_velocity_spike does NOT fire when avg gap is under 24h", () => {
  // All messages within a few hours of each other
  const now = Date.now();
  const s = extractSignals(
    email({
      thread: [
        { sender: "alice@corp.com", ts: new Date(now - 4 * 3600000).toISOString() },
        { sender: "bob@corp.com", ts: new Date(now - 3 * 3600000).toISOString() },
        { sender: "alice@corp.com", ts: new Date(now - 2 * 3600000).toISOString() },
        { sender: "bob@corp.com", ts: new Date(now - 600000).toISOString() },
      ],
    }),
    ctx(),
  );
  assert.equal(s.some((x) => x.signal === "thread_velocity_spike"), false);
});

test("thread_velocity_spike does NOT fire when thread has fewer than 3 messages", () => {
  const now = Date.now();
  const s = extractSignals(
    email({
      thread: [
        { sender: "alice@corp.com", ts: new Date(now - 5 * 86400000).toISOString() },
        { sender: "bob@corp.com", ts: new Date(now - 600000).toISOString() },
      ],
    }),
    ctx(),
  );
  assert.equal(s.some((x) => x.signal === "thread_velocity_spike"), false);
});

// ── Account behavior: behavior_changepoint ──────────────────────────────

test("behavior_changepoint fires when 4+ behavioral dimensions shift", () => {
  // shiftCount increments:
  // 1: body length > 2× stddev from avg
  // 2: avg_link_count >= 0.1 but current link count = 0 (link drop)
  // 3: avg_attachment_count < 0.1 and current attachment >= 1
  // 4: hour < 6 (send at 3 AM UTC)
  const s = extractSignals(
    email({
      body_text: "x".repeat(5000),  // huge body, no URLs
      attachments: [{ name: "doc.pdf" }],
    }),
    ctx({
      ts: new Date("2026-04-17T03:00:00Z"), // 3 AM UTC → hour < 6
      senderHist: { n: 30, last_seen: new Date(Date.now() - 86400000) },
      fingerprint: {
        sample_count: 25,
        avg_body_length: 200,
        stddev_body_length: 50,
        avg_subject_length: 20,
        avg_link_count: 0.5,       // >= 0.1, but email has 0 links → shift
        avg_attachment_count: 0.0,  // < 0.1, but email has 1 attachment → shift
      },
    }),
  );
  const m = s.find((x) => x.signal === "behavior_changepoint");
  assert.ok(m, "behavior_changepoint should fire");
  assert.equal(m.score, 2.7);
  assert.ok(m.detail.dimensions_shifted >= 4);
});

test("behavior_changepoint does NOT fire when fewer than 4 dimensions shift", () => {
  // Only hour is unusual (< 6), everything else matches fingerprint
  const s = extractSignals(
    email({ body_text: "Hello there", attachments: [] }),
    ctx({
      ts: new Date("2026-04-17T03:00:00Z"),
      senderHist: { n: 30, last_seen: new Date(Date.now() - 86400000) },
      fingerprint: {
        sample_count: 25,
        avg_body_length: 11,
        stddev_body_length: 50,
        avg_subject_length: 5,
        avg_link_count: 0.0,
        avg_attachment_count: 0.0,
      },
    }),
  );
  assert.equal(s.some((x) => x.signal === "behavior_changepoint"), false);
});

test("behavior_changepoint does NOT fire when fingerprint sample_count < 20", () => {
  const s = extractSignals(
    email({
      body_text: "x".repeat(5000),
      attachments: [{ name: "doc.pdf" }],
    }),
    ctx({
      ts: new Date("2026-04-17T03:00:00Z"),
      senderHist: { n: 30, last_seen: new Date(Date.now() - 86400000) },
      fingerprint: {
        sample_count: 15,
        avg_body_length: 200,
        stddev_body_length: 50,
        avg_subject_length: 20,
        avg_link_count: 0.5,
        avg_attachment_count: 0.0,
      },
    }),
  );
  assert.equal(s.some((x) => x.signal === "behavior_changepoint"), false);
});

test("behavior_changepoint does NOT fire when senderHist.last_seen is missing", () => {
  const s = extractSignals(
    email({
      body_text: "x".repeat(5000),
      attachments: [{ name: "doc.pdf" }],
    }),
    ctx({
      ts: new Date("2026-04-17T03:00:00Z"),
      senderHist: { n: 30 },  // no last_seen
      fingerprint: {
        sample_count: 25,
        avg_body_length: 200,
        stddev_body_length: 50,
        avg_subject_length: 20,
        avg_link_count: 0.5,
        avg_attachment_count: 0.0,
      },
    }),
  );
  assert.equal(s.some((x) => x.signal === "behavior_changepoint"), false);
});
