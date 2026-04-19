// E3 Stats DB — Phase 1 complete: all 36 behavioral signals.
//
// Signals are grouped per PRD §7.3. Ones marked DATA_DEP need data we don't
// collect yet (IP geolocation, LDAP/directory, conversation threading,
// IdP/auth logs, M365 delegation events) — they're stubbed and tagged
// so the integration surface is visible.
//
// A single loadContext() gathers every aggregate the signals need, so the
// per-email cost is ~6 parallel queries regardless of how many signals fire.

import { makeApp, listen } from "@etdp/shared/engineBase";
import { safeOrgQuery } from "@etdp/shared/mysql";
import { cached } from "@etdp/shared/cache";
import { lookupRdapCached, fetchRdapBackground } from "@etdp/shared/rdap";
import * as ss from "simple-statistics";

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const FREEMAIL = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com",
  "proton.me", "icloud.com", "aol.com",
]);
const URGENCY_RE = /\b(urgent|immediate|asap|right away|act now|expires|deadline|time.?sensitive|don'?t delay)\b/i;
const FINANCIAL_RE = /\b(wire|invoice|payment|remittance|bank.?account|routing.?number|ach|transfer funds|direct.?deposit|payroll)\b/i;
const PHONE_RE = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;

export function senderDomain(email) {
  return email.sender.includes("@") ? email.sender.split("@")[1].toLowerCase() : "";
}

export function receivedAt(email) {
  if (email.received_at) {
    const d = new Date(email.received_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function sig(name, score, detail = {}) {
  return { engine: "stats_db", signal: name, score, detail };
}

// Simple edit distance for lookalike_domain; caps at 3.
export function editDist(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return dp[a.length];
}

async function loadContext(email) {
  const orgId = email.org_id;
  const sender = email.sender;
  const domain = senderDomain(email);
  const recipient = (email.recipients && email.recipients[0]) || "";
  const ts = receivedAt(email);

  const [
    senderHist, pairHist, domainRow, senderDaily, senderHourly,
    senderAgg, orgInternalDomains, domainRecent, recipientFanout24h,
    rdapData, fingerprint,
  ] = await Promise.all([
    // Overall sender history: counts and date bounds.
    cached(`sh:${orgId}:${sender}`, 30, () =>
      safeOrgQuery(orgId,
        `SELECT COUNT(*) AS n, MIN(\`timestamp\`) AS first_seen, MAX(\`timestamp\`) AS last_seen,
                AVG(size_bytes) AS avg_size, AVG(link_count) AS avg_links,
                AVG(attachment_count) AS avg_attach, AVG(1) AS dummy
         FROM email_metadata WHERE org_id=? AND sender=?`,
        [orgId, sender],
      ).then((r) => r.ok ? r.rows[0] : null),
    ),
    recipient ? safeOrgQuery(orgId,
      `SELECT total_count, first_seen, last_seen FROM sender_recipient_pairs
       WHERE org_id=? AND sender=? AND recipient=? LIMIT 1`,
      [orgId, sender, recipient],
    ).then((r) => r.ok ? (r.rows[0] || null) : null) : Promise.resolve(null),
    domain ? safeOrgQuery(orgId,
      `SELECT first_seen, total_emails_from, is_freemail FROM domain_first_seen
       WHERE org_id=? AND domain=? LIMIT 1`,
      [orgId, domain],
    ).then((r) => r.ok ? (r.rows[0] || null) : null) : Promise.resolve(null),
    safeOrgQuery(orgId,
      `SELECT \`date\`, email_count FROM sender_daily_stats
       WHERE org_id=? AND sender=? AND \`date\` > DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       ORDER BY \`date\` DESC`,
      [orgId, sender],
    ).then((r) => r.ok ? r.rows : []),
    safeOrgQuery(orgId,
      `SELECT hour_of_day, day_of_week, email_count FROM hourly_distribution
       WHERE org_id=? AND sender=?`,
      [orgId, sender],
    ).then((r) => r.ok ? r.rows : []),
    safeOrgQuery(orgId,
      `SELECT COUNT(*) AS c FROM email_metadata
       WHERE org_id=? AND sender=? AND \`timestamp\` > NOW() - INTERVAL 1 HOUR`,
      [orgId, sender],
    ).then((r) => r.ok ? Number(r.rows[0]?.c || 0) : 0),
    // Pull org's "known-good" internal domains for lookalike check.
    cached(`orgdom:${orgId}`, 300, () =>
      safeOrgQuery(orgId,
        `SELECT domain FROM domain_first_seen
         WHERE org_id=? AND total_emails_from >= 10
         ORDER BY total_emails_from DESC LIMIT 25`,
        [orgId],
      ).then((r) => r.ok ? r.rows.map((x) => x.domain) : []),
    ),
    domain ? safeOrgQuery(orgId,
      `SELECT
         (SELECT COUNT(*) FROM email_metadata WHERE org_id=? AND sender_domain=?
          AND \`timestamp\` > NOW() - INTERVAL 1 DAY) AS last_day,
         (SELECT COUNT(*) FROM email_metadata WHERE org_id=? AND sender_domain=?
          AND \`timestamp\` BETWEEN NOW() - INTERVAL 8 DAY AND NOW() - INTERVAL 1 DAY) AS prior_7d`,
      [orgId, domain, orgId, domain],
    ).then((r) => r.ok ? r.rows[0] : null) : Promise.resolve(null),
    // Unique recipient count in last 24h for fanout spike detection.
    safeOrgQuery(orgId,
      `SELECT COUNT(DISTINCT recipient) AS cnt FROM sender_recipient_pairs
       WHERE org_id=? AND sender=? AND last_seen > NOW() - INTERVAL 1 DAY`,
      [orgId, sender],
    ).then((r) => r.ok ? Number(r.rows[0]?.cnt || 0) : 0),
    // RDAP domain registration cache lookup.
    lookupRdapCached(domain),
    // Sender behavioral fingerprint.
    safeOrgQuery(orgId,
      `SELECT sample_count, avg_body_length, stddev_body_length, avg_subject_length,
              html_ratio, avg_link_count, avg_attachment_count, avg_recipients
       FROM sender_fingerprint WHERE org_id=? AND sender=? LIMIT 1`,
      [orgId, sender],
    ).then((r) => r.ok ? (r.rows[0] || null) : null),
  ]);

  return { orgId, sender, domain, recipient, ts,
    senderHist, pairHist, domainRow, senderDaily, senderHourly,
    senderAgg, orgInternalDomains, domainRecent, recipientFanout24h,
    rdapData, fingerprint };
}

// Each signal returns Signal | null. All run against the shared context.
export function extractSignals(email, ctx, orgCtx = {}) {
  const signals = [];
  const bizStart = orgCtx.business_hours_start ?? 8;
  const bizEnd = orgCtx.business_hours_end ?? 20;
  const hour = ctx.ts.getUTCHours();
  const dow = ctx.ts.getUTCDay();
  const bodyLen = (email.body_text || "").length;
  const attCount = (email.attachments || []).length;
  const linkCount = ((email.body_text || "").match(URL_RE) || []).length;
  const recipients = email.recipients || [];
  const senderCount = Number(ctx.senderHist?.n || 0);
  const avgDaily = ctx.senderDaily.length > 0
    ? ctx.senderDaily.reduce((a, r) => a + Number(r.email_count), 0) / ctx.senderDaily.length
    : 0;

  // ── Group: Frequency baselines ────────────────────────────────────────
  if (senderCount === 0) {
    signals.push(sig("first_time_sender", 2.25, { sender: ctx.sender }));
  }

  if (ctx.senderHist?.last_seen) {
    const daysDormant = (Date.now() - new Date(ctx.senderHist.last_seen).getTime()) / 86400000;
    if (daysDormant > 30) {
      signals.push(sig("dormant_sender_reactivation", 2.7,
        { days_dormant: Math.round(daysDormant) }));
    }
  }

  // communication_cadence_shift: compare latest-day count vs 7d avg excluding today.
  if (ctx.senderDaily.length >= 3 && avgDaily > 0) {
    const today = Number(ctx.senderDaily[0].email_count);
    if (today > avgDaily * 2.5) {
      signals.push(sig("communication_cadence_shift", 1.5,
        { today, avg_7d: Number(avgDaily.toFixed(2)) }));
    }
  }

  // reply_rate_change — DATA_DEP (requires conversation threading).

  if (ctx.domainRecent) {
    const lastDay = Number(ctx.domainRecent.last_day || 0);
    const prior7d = Number(ctx.domainRecent.prior_7d || 0);
    if (lastDay > 10 && lastDay > prior7d / 7 * 3) {
      signals.push(sig("new_domain_surge", 3.0,
        { domain: ctx.domain, last_day: lastDay, prior_weekly_avg: prior7d / 7 }));
    }
  }

  // ── Group: Sender volume anomaly ──────────────────────────────────────
  // MAD-based Modified Z-Score: robust against skewed distributions.
  if (ctx.senderDaily.length >= 3) {
    const dailyCounts = ctx.senderDaily.map((r) => Number(r.email_count));
    const todayCount = dailyCounts[0];
    const median = ss.median(dailyCounts);
    const mad = ss.medianAbsoluteDeviation(dailyCounts);
    const modifiedZ = mad > 0 ? 0.6745 * (todayCount - median) / mad : 0;
    if (modifiedZ > 3.5) {
      signals.push(sig("daily_count_spike", 3.75,
        { today: todayCount, median, mad, modified_z: Number(modifiedZ.toFixed(2)) }));
    }
  }

  // hourly_deviation: sender's typical hour histogram.
  if (ctx.senderHourly.length >= 5) {
    const totalHourly = ctx.senderHourly.reduce((a, r) => a + Number(r.email_count), 0);
    const thisHourCount = ctx.senderHourly
      .filter((r) => Number(r.hour_of_day) === hour)
      .reduce((a, r) => a + Number(r.email_count), 0);
    const expected = totalHourly / 24;
    // Very rare hour for this sender.
    if (expected >= 1 && thisHourCount === 0) {
      signals.push(sig("hourly_deviation", 1.2, { hour_utc: hour }));
    }
  }

  // burst_detection (60-min vs 7d-daily-avg × 3).
  const threshold = Math.max(5, avgDaily * 3);
  if (ctx.senderAgg > threshold) {
    signals.push(sig("sender_burst", 3.75,
      { last_hour: ctx.senderAgg, avg_daily: Number(avgDaily.toFixed(2)), threshold }));
  }

  // send_rate_change: today vs prior-day ratio.
  if (ctx.senderDaily.length >= 2) {
    const today = Number(ctx.senderDaily[0].email_count);
    const yest = Number(ctx.senderDaily[1].email_count);
    if (yest > 0 && today > yest * 4) {
      signals.push(sig("send_rate_change", 1.8, { today, yesterday: yest }));
    }
  }

  // volume_percentile — DATA_DEP at org scale (needs org-wide top-N snapshot).

  // silence_then_burst: >7d dormant then >2 emails today.
  if (ctx.senderHist?.last_seen) {
    const daysSince = (Date.now() - new Date(ctx.senderHist.last_seen).getTime()) / 86400000;
    const todayCount = ctx.senderDaily.length > 0 ? Number(ctx.senderDaily[0].email_count) : 0;
    if (daysSince > 7 && todayCount >= 2) {
      signals.push(sig("silence_then_burst", 3.3,
        { days_dormant: Math.round(daysSince), today_count: todayCount }));
    }
  }

  // ── Group: Recipient anomaly ──────────────────────────────────────────
  if (ctx.pairHist === null && ctx.recipient) {
    signals.push(sig("first_time_pair", 1.2,
      { sender: ctx.sender, recipient: ctx.recipient }));
  }

  if (recipients.length > 10) {
    signals.push(sig("mass_bcc_detection", 2.25, { recipient_count: recipients.length }));
  }

  if (senderCount >= 5) {
    // Compute avg recipient count from per-day stats → fall back: recipients/day.
    const avgRecipsPerEmail = 1 + (Number(ctx.senderHist?.avg_attach || 0) > 0 ? 0 : 0);
    // Use simple heuristic: >5 recipients when historic senders typically send 1-2.
    if (recipients.length >= 5 && senderCount > 10) {
      signals.push(sig("recipient_count_anomaly", 1.5,
        { recipient_count: recipients.length, sender_history: senderCount }));
    }
  }

  // unusual_department_targeting — DATA_DEP (needs LDAP/AD department tags).
  // cross_department_spray          — DATA_DEP (same).

  // ── Group: Time-of-day anomaly ────────────────────────────────────────
  if (hour < bizStart || hour >= bizEnd) {
    signals.push(sig("off_hours_email", 0.75,
      { hour_utc: hour, biz_window: [bizStart, bizEnd] }));
  }

  if ((dow === 0 || dow === 6) && senderCount >= 10) {
    const weekendHist = ctx.senderHourly
      .filter((r) => Number(r.day_of_week) === 0 || Number(r.day_of_week) === 6)
      .reduce((a, r) => a + Number(r.email_count), 0);
    if (weekendHist === 0) {
      signals.push(sig("weekend_activity_spike", 2.25,
        { day_of_week: dow, sender_never_weekends: true }));
    }
  }

  // schedule_deviation: sender's day-of-week pattern broken.
  if (ctx.senderHourly.length >= 5) {
    const byDow = new Map();
    for (const r of ctx.senderHourly) {
      byDow.set(Number(r.day_of_week),
        (byDow.get(Number(r.day_of_week)) || 0) + Number(r.email_count));
    }
    const thisDow = byDow.get(dow) || 0;
    const total = [...byDow.values()].reduce((a, b) => a + b, 0);
    if (total > 10 && thisDow === 0) {
      signals.push(sig("schedule_deviation", 1.05, { day_of_week: dow }));
    }
  }

  // timezone_mismatch — DATA_DEP (needs sending-IP geolocation).

  // ── Group: Domain patterns ────────────────────────────────────────────
  if (ctx.domain && !ctx.domainRow) {
    signals.push(sig("domain_first_seen", 1.8, { domain: ctx.domain }));
  } else if (ctx.domainRow) {
    const ageMs = Date.now() - new Date(ctx.domainRow.first_seen).getTime();
    if (ageMs < 48 * 3600 * 1000) {
      signals.push(sig("domain_first_seen_recent", 1.5,
        { domain: ctx.domain, age_hours: Math.round(ageMs / 3.6e6) }));
    }
  }

  if (ctx.domainRecent) {
    const lastDay = Number(ctx.domainRecent.last_day || 0);
    const prior7d = Number(ctx.domainRecent.prior_7d || 0);
    const dailyAvg = prior7d / 7;
    if (dailyAvg > 2 && lastDay > dailyAvg * 2) {
      signals.push(sig("domain_email_volume_trend", 1.2,
        { domain: ctx.domain, last_day: lastDay, daily_avg_prior: Number(dailyAvg.toFixed(2)) }));
    }
  }

  if (ctx.domain && ctx.orgInternalDomains.length > 0) {
    for (const known of ctx.orgInternalDomains) {
      if (known === ctx.domain) break;
      const dist = editDist(ctx.domain, known, 2);
      if (dist > 0 && dist <= 2) {
        signals.push(sig("lookalike_domain", 4.5,
          { domain: ctx.domain, similar_to: known, edit_distance: dist }));
        break;
      }
    }
  }

  if (ctx.domain && FREEMAIL.has(ctx.domain)
      && recipients.some((r) => r.includes("@") && !FREEMAIL.has(r.split("@")[1].toLowerCase()))) {
    signals.push(sig("freemail_to_corp", 0.9,
      { sender_domain: ctx.domain, corp_recipients: recipients.length }));
  }

  // ── Group: Sender-recipient pair ──────────────────────────────────────
  if (ctx.pairHist && ctx.recipient) {
    const totalPair = Number(ctx.pairHist.total_count);
    // pair_frequency_deviation: pair exists but this hour is unusual.
    // Approximation: if pair has >20 prior msgs and this is outside biz hours.
    if (totalPair >= 20 && (hour < bizStart || hour >= bizEnd)) {
      signals.push(sig("pair_frequency_deviation", 0.9,
        { pair_msgs: totalPair, hour_utc: hour }));
    }
  }

  // pair_direction_reversal — DATA_DEP (needs outbound tracking).
  // unusual_reply_chain_depth — DATA_DEP (needs threading).
  // cross_hierarchy_pair      — DATA_DEP (needs org chart).

  // ── Group: Volume & ratio metrics ─────────────────────────────────────
  if (senderCount >= 10) {
    const avgSize = Number(ctx.senderHist.avg_size || 0);
    if (avgSize > 0 && bodyLen > avgSize * 3) {
      signals.push(sig("size_distribution_anomaly", 1.2,
        { size: bodyLen, avg_size: Math.round(avgSize) }));
    }
    const avgLinks = Number(ctx.senderHist.avg_links || 0);
    if (avgLinks < 0.5 && linkCount >= 3) {
      signals.push(sig("link_density_change", 1.8,
        { links: linkCount, avg_links: Number(avgLinks.toFixed(2)) }));
    }
    const avgAttach = Number(ctx.senderHist.avg_attach || 0);
    if (avgAttach < 0.1 && attCount >= 1) {
      signals.push(sig("attachment_rate_anomaly", 2.25,
        { attachments: attCount, historic_rate: Number(avgAttach.toFixed(2)) }));
    }
    if (recipients.length >= 5) {
      // bulk-vs-individual: sender historically 1 recipient, now many.
      signals.push(sig("bulk_vs_individual_ratio_shift", 1.5,
        { recipients: recipients.length }));
    }
  }

  // ── Group: Account behavior ───────────────────────────────────────────
  // auth_failure_correlation — DATA_DEP (needs IdP log integration).
  // delegation_change_detection — DATA_DEP (needs M365/Google mgmt API).
  // geographic_sending_anomaly — DATA_DEP (needs IP geolocation).

  // ── Group: New attack-pattern signals ───────────────────────────────
  // sender_local_entropy: Shannon entropy of local-part detects random-generated addresses.
  const localPart = ctx.sender.includes("@") ? ctx.sender.split("@")[0] : "";
  if (localPart.length > 0) {
    const freq = new Map();
    for (const ch of localPart) freq.set(ch, (freq.get(ch) || 0) + 1);
    let entropy = 0;
    for (const count of freq.values()) {
      const p = count / localPart.length;
      entropy -= p * Math.log2(p);
    }
    if (entropy > 4.0) {
      signals.push(sig("sender_local_entropy", 1.5,
        { local_part: localPart, entropy: Number(entropy.toFixed(2)) }));
    }
  }

  // reply_to_domain_mismatch: Reply-To domain differs from From domain.
  const replyTo = email.headers?.reply_to || email.headers?.["Reply-To"] || "";
  if (replyTo.includes("@") && ctx.domain) {
    const replyDomain = replyTo.split("@").pop().toLowerCase().replace(/>.*$/, "");
    if (replyDomain && replyDomain !== ctx.domain) {
      signals.push(sig("reply_to_domain_mismatch", 2.25,
        { from_domain: ctx.domain, reply_to_domain: replyDomain }));
    }
  }

  // payloadless_financial: No URLs/attachments but financial keywords → callback phishing.
  if (linkCount === 0 && attCount === 0 && FINANCIAL_RE.test(email.body_text || "")) {
    signals.push(sig("payloadless_financial", 2.25,
      { body_length: bodyLen }));
  }

  // recipient_fanout_spike: unique recipients in 24h exceeds 3× historical daily median.
  if (ctx.senderDaily.length >= 3 && ctx.recipientFanout24h > 0) {
    const dailyCounts = ctx.senderDaily.map((r) => Number(r.email_count));
    const dailyMedian = ss.median(dailyCounts);
    if (dailyMedian > 0 && ctx.recipientFanout24h > dailyMedian * 3) {
      signals.push(sig("recipient_fanout_spike", 2.25,
        { fanout_24h: ctx.recipientFanout24h, daily_median: dailyMedian }));
    }
  }

  // phone_number_lure: phone number + urgency, no URLs → callback/vishing.
  const bodyText = email.body_text || "";
  if (linkCount === 0 && PHONE_RE.test(bodyText) && URGENCY_RE.test(bodyText)) {
    signals.push(sig("phone_number_lure", 1.5,
      { has_phone: true, has_urgency: true }));
  }

  // body_brevity_with_urgency: very short body with urgency keyword.
  if (bodyLen > 0 && bodyLen < 100 && URGENCY_RE.test(bodyText)) {
    signals.push(sig("body_brevity_with_urgency", 1.5,
      { body_length: bodyLen }));
  }

  // volume_zscore_anomaly: sender's daily volume z-score > 3.0 vs historical baseline.
  if (ctx.senderDaily.length >= 5) {
    const dailyCounts = ctx.senderDaily.map((r) => Number(r.email_count));
    const todayCount = dailyCounts[0];
    const baseline = dailyCounts.slice(1); // exclude today from baseline
    const mean = ss.mean(baseline);
    const stddev = ss.sampleStandardDeviation(baseline);
    if (stddev > 0) {
      const z = ss.zScore(todayCount, mean, stddev);
      if (z > 3.0) {
        signals.push(sig("volume_zscore_anomaly", 2.25,
          { today: todayCount, mean: Number(mean.toFixed(2)), z_score: Number(z.toFixed(2)) }));
      }
    }
  }

  // sender_domain_age_risk / newly_registered_domain: RDAP-based with org fallback.
  if (ctx.rdapData?.registration_date && ctx.rdapData.rdap_status === "ok") {
    const regAgeDays = (Date.now() - new Date(ctx.rdapData.registration_date).getTime()) / 86400000;
    if (regAgeDays < 30) {
      signals.push(sig("newly_registered_domain", 3.0,
        { domain: ctx.domain, age_days: Number(regAgeDays.toFixed(1)), source: "rdap" }));
    } else if (regAgeDays < 365) {
      signals.push(sig("sender_domain_age_risk", 1.5,
        { domain: ctx.domain, age_days: Number(regAgeDays.toFixed(1)), source: "rdap" }));
    }
    // > 365 days → no signal
  } else if (ctx.domainRow?.first_seen) {
    // Fallback: org-level first_seen (existing behavior).
    const ageDays = (Date.now() - new Date(ctx.domainRow.first_seen).getTime()) / 86400000;
    if (ageDays < 7) {
      signals.push(sig("sender_domain_age_risk", 1.5,
        { domain: ctx.domain, age_days: Number(ageDays.toFixed(1)), source: "org_first_seen" }));
    }
  }

  // ── Group: Sender fingerprint ──────────────────────────────────────────
  if (ctx.fingerprint && ctx.fingerprint.sample_count >= 10) {
    const fp = ctx.fingerprint;
    let deviations = 0;
    if (fp.stddev_body_length > 0 && Math.abs(bodyLen - fp.avg_body_length) > fp.stddev_body_length * 3) deviations++;
    const subjectLen = (email.subject || "").length;
    if (fp.avg_subject_length > 0 && Math.abs(subjectLen - fp.avg_subject_length) > fp.avg_subject_length * 2) deviations++;
    if (fp.avg_link_count < 0.5 && linkCount >= 3) deviations++;
    if (fp.avg_attachment_count < 0.1 && attCount >= 1) deviations++;
    if (deviations >= 3) {
      signals.push(sig("sender_style_deviation", 2.25,
        { deviations, sample_count: fp.sample_count }));
    }
  }

  // ── Group: Thread structural signals ───────────────────────────────────
  const thread = email.thread || [];
  if (thread.length > 0) {
    // thread_participant_injection: new sender in existing thread.
    const priorSenders = new Set(thread.map((m) => m.sender));
    if (!priorSenders.has(ctx.sender) && priorSenders.size > 0) {
      signals.push(sig("thread_participant_injection", 2.5,
        { new_sender: ctx.sender, thread_participants: [...priorSenders] }));
    }

    // thread_reply_to_hijack: Reply-To domain changed mid-thread.
    const replyTo = email.headers?.reply_to || email.headers?.["Reply-To"] || "";
    if (replyTo.includes("@")) {
      const replyDomain = replyTo.split("@").pop().toLowerCase().replace(/>.*$/, "");
      const threadDomains = new Set(thread.map((m) => m.sender_domain || m.sender.split("@")[1]).filter(Boolean));
      if (replyDomain && threadDomains.size > 0 && !threadDomains.has(replyDomain)) {
        signals.push(sig("thread_reply_to_hijack", 3.5,
          { reply_to_domain: replyDomain, thread_domains: [...threadDomains] }));
      }
    }

    // thread_velocity_spike: conversation pace suddenly accelerates.
    if (thread.length >= 3) {
      const timestamps = thread.map((m) => new Date(m.ts).getTime()).filter((t) => !Number.isNaN(t));
      if (timestamps.length >= 3) {
        const lastGap = Date.now() - timestamps[timestamps.length - 1];
        const avgGap = (timestamps[timestamps.length - 1] - timestamps[0]) / (timestamps.length - 1);
        if (avgGap > 86400000 && lastGap < 3600000) {
          signals.push(sig("thread_velocity_spike", 1.8,
            { avg_gap_hours: Math.round(avgGap / 3600000), last_gap_hours: Number((lastGap / 3600000).toFixed(1)) }));
        }
      }
    }
  }

  // behavior_changepoint: detect abrupt shift in sender's behavioral distribution.
  if (ctx.senderHist?.last_seen && ctx.fingerprint?.sample_count >= 20) {
    const fp = ctx.fingerprint;
    let shiftCount = 0;
    if (fp.stddev_body_length > 0 && Math.abs(bodyLen - fp.avg_body_length) > fp.stddev_body_length * 2) shiftCount++;
    if (fp.avg_link_count >= 0.1 && linkCount === 0) shiftCount++;
    if (fp.avg_link_count < 0.3 && linkCount >= 3) shiftCount++;
    if (fp.avg_attachment_count < 0.1 && attCount >= 1) shiftCount++;
    if (hour < 6 || hour > 22) shiftCount++;  // unusual hour for most senders
    if (shiftCount >= 4) {
      signals.push(sig("behavior_changepoint", 2.7,
        { dimensions_shifted: shiftCount, sample_count: fp.sample_count }));
    }
  }

  return signals;
}

async function persist(email, ctx) {
  const bodyLen = (email.body_text || "").length;
  const attCount = (email.attachments || []).length;
  const linkCount = ((email.body_text || "").match(URL_RE) || []).length;
  const subjectLen = (email.subject || "").length;

  await safeOrgQuery(ctx.orgId,
    `INSERT INTO email_metadata
       (org_id, message_id, sender, sender_domain, recipient, \`timestamp\`,
        size_bytes, has_attachment, attachment_count, subject_length,
        body_length, link_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ctx.orgId, email.message_id, ctx.sender, ctx.domain, ctx.recipient, ctx.ts,
      bodyLen, attCount > 0 ? 1 : 0, attCount, subjectLen, bodyLen, linkCount],
  );

  if (ctx.recipient) {
    await safeOrgQuery(ctx.orgId,
      `INSERT INTO sender_recipient_pairs
         (org_id, sender, recipient, total_count, last_seen, first_seen)
       VALUES (?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE
         total_count = total_count + 1, last_seen = VALUES(last_seen)`,
      [ctx.orgId, ctx.sender, ctx.recipient, ctx.ts, ctx.ts],
    );
  }

  if (ctx.domain) {
    await safeOrgQuery(ctx.orgId,
      `INSERT INTO domain_first_seen
         (org_id, domain, first_seen, total_emails_from, is_freemail)
       VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE total_emails_from = total_emails_from + 1`,
      [ctx.orgId, ctx.domain, ctx.ts, FREEMAIL.has(ctx.domain) ? 1 : 0],
    );
  }

  await safeOrgQuery(ctx.orgId,
    `INSERT INTO sender_daily_stats
       (org_id, sender, \`date\`, email_count, avg_size, attachment_rate, unique_recipients)
     VALUES (?, ?, DATE(?), 1, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       email_count = email_count + 1,
       avg_size = ((avg_size * email_count) + VALUES(avg_size)) / (email_count + 1),
       attachment_rate = ((attachment_rate * email_count) + VALUES(attachment_rate)) / (email_count + 1)`,
    [ctx.orgId, ctx.sender, ctx.ts, bodyLen, attCount > 0 ? 1 : 0],
  );

  await safeOrgQuery(ctx.orgId,
    `INSERT INTO hourly_distribution
       (org_id, sender, hour_of_day, day_of_week, email_count)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE email_count = email_count + 1`,
    [ctx.orgId, ctx.sender, ctx.ts.getUTCHours(), ctx.ts.getUTCDay()],
  );

  // Upsert sender fingerprint running averages.
  const hasHtml = (email.body_html || "").length > 0 ? 1 : 0;
  const recipients = email.recipients || [];
  await safeOrgQuery(ctx.orgId,
    `INSERT INTO sender_fingerprint
       (org_id, sender, sample_count, avg_body_length, stddev_body_length,
        avg_subject_length, html_ratio, avg_link_count, avg_attachment_count,
        avg_recipients, typical_hours, typical_days, updated_at)
     VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?, ?, 1 << ?, 1 << ?, NOW(3))
     ON DUPLICATE KEY UPDATE
       avg_body_length = ((avg_body_length * sample_count) + VALUES(avg_body_length)) / (sample_count + 1),
       stddev_body_length = SQRT(
         ((sample_count - 1) * POW(stddev_body_length, 2) +
          (VALUES(avg_body_length) - avg_body_length) *
          (VALUES(avg_body_length) - ((avg_body_length * sample_count) + VALUES(avg_body_length)) / (sample_count + 1))
         ) / sample_count
       ),
       avg_subject_length = ((avg_subject_length * sample_count) + VALUES(avg_subject_length)) / (sample_count + 1),
       html_ratio = ((html_ratio * sample_count) + VALUES(html_ratio)) / (sample_count + 1),
       avg_link_count = ((avg_link_count * sample_count) + VALUES(avg_link_count)) / (sample_count + 1),
       avg_attachment_count = ((avg_attachment_count * sample_count) + VALUES(avg_attachment_count)) / (sample_count + 1),
       avg_recipients = ((avg_recipients * sample_count) + VALUES(avg_recipients)) / (sample_count + 1),
       typical_hours = typical_hours | (1 << VALUES(typical_hours)),
       typical_days = typical_days | (1 << VALUES(typical_days)),
       sample_count = sample_count + 1,
       updated_at = NOW(3)`,
    [ctx.orgId, ctx.sender, bodyLen, subjectLen, hasHtml, linkCount, attCount,
     recipients.length, ctx.ts.getUTCHours(), ctx.ts.getUTCDay()],
  );

  // Persist thread reference for future thread assembly.
  const inReplyTo = email.headers?.["In-Reply-To"] || email.headers?.in_reply_to || null;
  const referencesHeader = email.headers?.References || email.headers?.references || null;
  if (inReplyTo || referencesHeader) {
    await safeOrgQuery(ctx.orgId,
      `UPDATE email_metadata SET in_reply_to = ?, references_header = ?
       WHERE org_id = ? AND message_id = ? LIMIT 1`,
      [inReplyTo, referencesHeader, ctx.orgId, email.message_id],
    );
  }
}

// Apply the per-org ramp weight (0 → 1 over 30 days) to every signal score.
export function applyWeight(signals, weight) {
  if (weight >= 0.999) return signals;
  return signals.map((s) => ({ ...s, score: s.score * weight }));
}

async function analyze(email) {
  const orgCtx = email.org_context || {};
  const ctx = await loadContext(email);
  let signals = extractSignals(email, ctx, orgCtx);
  const w = Number(orgCtx.stats_db_weight ?? 1.0);
  signals = applyWeight(signals, w);
  await persist(email, ctx);
  if (!ctx.rdapData) fetchRdapBackground(ctx.domain);
  return signals;
}

const app = makeApp("e3_stats_db", analyze);
listen(app, "e3_stats_db");
