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
    orgInternalDomains: [], domainRecent: null,
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
