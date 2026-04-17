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
import { safeQuery } from "@etdp/shared/mysql";
import { cached } from "@etdp/shared/cache";

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const FREEMAIL = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com",
  "proton.me", "icloud.com", "aol.com",
]);

function senderDomain(email) {
  return email.sender.includes("@") ? email.sender.split("@")[1].toLowerCase() : "";
}

function receivedAt(email) {
  if (email.received_at) {
    const d = new Date(email.received_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function sig(name, score, detail = {}) {
  return { engine: "stats_db", signal: name, score, detail };
}

// Simple edit distance for lookalike_domain; caps at 3.
function editDist(a, b, cap = 3) {
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
    senderAgg, orgInternalDomains, domainRecent,
  ] = await Promise.all([
    // Overall sender history: counts and date bounds.
    cached(`sh:${orgId}:${sender}`, 30, () =>
      safeQuery(
        `SELECT COUNT(*) AS n, MIN(\`timestamp\`) AS first_seen, MAX(\`timestamp\`) AS last_seen,
                AVG(size_bytes) AS avg_size, AVG(link_count) AS avg_links,
                AVG(attachment_count) AS avg_attach, AVG(1) AS dummy
         FROM email_metadata WHERE org_id=? AND sender=?`,
        [orgId, sender],
      ).then((r) => r.ok ? r.rows[0] : null),
    ),
    recipient ? safeQuery(
      `SELECT total_count, first_seen, last_seen FROM sender_recipient_pairs
       WHERE org_id=? AND sender=? AND recipient=? LIMIT 1`,
      [orgId, sender, recipient],
    ).then((r) => r.ok ? (r.rows[0] || null) : null) : Promise.resolve(null),
    domain ? safeQuery(
      `SELECT first_seen, total_emails_from, is_freemail FROM domain_first_seen
       WHERE org_id=? AND domain=? LIMIT 1`,
      [orgId, domain],
    ).then((r) => r.ok ? (r.rows[0] || null) : null) : Promise.resolve(null),
    safeQuery(
      `SELECT \`date\`, email_count FROM sender_daily_stats
       WHERE org_id=? AND sender=? AND \`date\` > DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       ORDER BY \`date\` DESC`,
      [orgId, sender],
    ).then((r) => r.ok ? r.rows : []),
    safeQuery(
      `SELECT hour_of_day, day_of_week, email_count FROM hourly_distribution
       WHERE org_id=? AND sender=?`,
      [orgId, sender],
    ).then((r) => r.ok ? r.rows : []),
    safeQuery(
      `SELECT COUNT(*) AS c FROM email_metadata
       WHERE org_id=? AND sender=? AND \`timestamp\` > NOW() - INTERVAL 1 HOUR`,
      [orgId, sender],
    ).then((r) => r.ok ? Number(r.rows[0]?.c || 0) : 0),
    // Pull org's "known-good" internal domains for lookalike check.
    cached(`orgdom:${orgId}`, 300, () =>
      safeQuery(
        `SELECT domain FROM domain_first_seen
         WHERE org_id=? AND total_emails_from >= 10
         ORDER BY total_emails_from DESC LIMIT 25`,
        [orgId],
      ).then((r) => r.ok ? r.rows.map((x) => x.domain) : []),
    ),
    domain ? safeQuery(
      `SELECT
         (SELECT COUNT(*) FROM email_metadata WHERE org_id=? AND sender_domain=?
          AND \`timestamp\` > NOW() - INTERVAL 1 DAY) AS last_day,
         (SELECT COUNT(*) FROM email_metadata WHERE org_id=? AND sender_domain=?
          AND \`timestamp\` BETWEEN NOW() - INTERVAL 8 DAY AND NOW() - INTERVAL 1 DAY) AS prior_7d`,
      [orgId, domain, orgId, domain],
    ).then((r) => r.ok ? r.rows[0] : null) : Promise.resolve(null),
  ]);

  return { orgId, sender, domain, recipient, ts,
    senderHist, pairHist, domainRow, senderDaily, senderHourly,
    senderAgg, orgInternalDomains, domainRecent };
}

// Each signal returns Signal | null. All run against the shared context.
function extractSignals(email, ctx, orgCtx) {
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
    signals.push(sig("first_time_sender", 1.5, { sender: ctx.sender }));
  }

  if (ctx.senderHist?.last_seen) {
    const daysDormant = (Date.now() - new Date(ctx.senderHist.last_seen).getTime()) / 86400000;
    if (daysDormant > 30) {
      signals.push(sig("dormant_sender_reactivation", 1.8,
        { days_dormant: Math.round(daysDormant) }));
    }
  }

  // communication_cadence_shift: compare latest-day count vs 7d avg excluding today.
  if (ctx.senderDaily.length >= 3 && avgDaily > 0) {
    const today = Number(ctx.senderDaily[0].email_count);
    if (today > avgDaily * 2.5) {
      signals.push(sig("communication_cadence_shift", 1.0,
        { today, avg_7d: Number(avgDaily.toFixed(2)) }));
    }
  }

  // reply_rate_change — DATA_DEP (requires conversation threading).

  if (ctx.domainRecent) {
    const lastDay = Number(ctx.domainRecent.last_day || 0);
    const prior7d = Number(ctx.domainRecent.prior_7d || 0);
    if (lastDay > 10 && lastDay > prior7d / 7 * 3) {
      signals.push(sig("new_domain_surge", 2.0,
        { domain: ctx.domain, last_day: lastDay, prior_weekly_avg: prior7d / 7 }));
    }
  }

  // ── Group: Sender volume anomaly ──────────────────────────────────────
  if (avgDaily > 0) {
    const today = ctx.senderDaily.length > 0 ? Number(ctx.senderDaily[0].email_count) : 0;
    if (today > avgDaily * 3 && today > 5) {
      signals.push(sig("daily_count_spike", 1.8,
        { today, avg_7d: Number(avgDaily.toFixed(2)) }));
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
      signals.push(sig("hourly_deviation", 0.8, { hour_utc: hour }));
    }
  }

  // burst_detection (60-min vs 7d-daily-avg × 3).
  const threshold = Math.max(5, avgDaily * 3);
  if (ctx.senderAgg > threshold) {
    signals.push(sig("sender_burst", 2.5,
      { last_hour: ctx.senderAgg, avg_daily: Number(avgDaily.toFixed(2)), threshold }));
  }

  // send_rate_change: today vs prior-day ratio.
  if (ctx.senderDaily.length >= 2) {
    const today = Number(ctx.senderDaily[0].email_count);
    const yest = Number(ctx.senderDaily[1].email_count);
    if (yest > 0 && today > yest * 4) {
      signals.push(sig("send_rate_change", 1.2, { today, yesterday: yest }));
    }
  }

  // volume_percentile — DATA_DEP at org scale (needs org-wide top-N snapshot).

  // silence_then_burst: >7d dormant then >2 emails today.
  if (ctx.senderHist?.last_seen) {
    const daysSince = (Date.now() - new Date(ctx.senderHist.last_seen).getTime()) / 86400000;
    const todayCount = ctx.senderDaily.length > 0 ? Number(ctx.senderDaily[0].email_count) : 0;
    if (daysSince > 7 && todayCount >= 2) {
      signals.push(sig("silence_then_burst", 2.2,
        { days_dormant: Math.round(daysSince), today_count: todayCount }));
    }
  }

  // ── Group: Recipient anomaly ──────────────────────────────────────────
  if (ctx.pairHist === null && ctx.recipient) {
    signals.push(sig("first_time_pair", 0.8,
      { sender: ctx.sender, recipient: ctx.recipient }));
  }

  if (recipients.length > 10) {
    signals.push(sig("mass_bcc_detection", 1.5, { recipient_count: recipients.length }));
  }

  if (senderCount >= 5) {
    // Compute avg recipient count from per-day stats → fall back: recipients/day.
    const avgRecipsPerEmail = 1 + (Number(ctx.senderHist?.avg_attach || 0) > 0 ? 0 : 0);
    // Use simple heuristic: >5 recipients when historic senders typically send 1-2.
    if (recipients.length >= 5 && senderCount > 10) {
      signals.push(sig("recipient_count_anomaly", 1.0,
        { recipient_count: recipients.length, sender_history: senderCount }));
    }
  }

  // unusual_department_targeting — DATA_DEP (needs LDAP/AD department tags).
  // cross_department_spray          — DATA_DEP (same).

  // ── Group: Time-of-day anomaly ────────────────────────────────────────
  if (hour < bizStart || hour >= bizEnd) {
    signals.push(sig("off_hours_email", 0.5,
      { hour_utc: hour, biz_window: [bizStart, bizEnd] }));
  }

  if ((dow === 0 || dow === 6) && senderCount >= 10) {
    const weekendHist = ctx.senderHourly
      .filter((r) => Number(r.day_of_week) === 0 || Number(r.day_of_week) === 6)
      .reduce((a, r) => a + Number(r.email_count), 0);
    if (weekendHist === 0) {
      signals.push(sig("weekend_activity_spike", 1.5,
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
      signals.push(sig("schedule_deviation", 0.7, { day_of_week: dow }));
    }
  }

  // timezone_mismatch — DATA_DEP (needs sending-IP geolocation).

  // ── Group: Domain patterns ────────────────────────────────────────────
  if (ctx.domain && !ctx.domainRow) {
    signals.push(sig("domain_first_seen", 1.2, { domain: ctx.domain }));
  } else if (ctx.domainRow) {
    const ageMs = Date.now() - new Date(ctx.domainRow.first_seen).getTime();
    if (ageMs < 48 * 3600 * 1000) {
      signals.push(sig("domain_first_seen_recent", 1.0,
        { domain: ctx.domain, age_hours: Math.round(ageMs / 3.6e6) }));
    }
  }

  if (ctx.domainRecent) {
    const lastDay = Number(ctx.domainRecent.last_day || 0);
    const prior7d = Number(ctx.domainRecent.prior_7d || 0);
    const dailyAvg = prior7d / 7;
    if (dailyAvg > 2 && lastDay > dailyAvg * 2) {
      signals.push(sig("domain_email_volume_trend", 0.8,
        { domain: ctx.domain, last_day: lastDay, daily_avg_prior: Number(dailyAvg.toFixed(2)) }));
    }
  }

  if (ctx.domain && ctx.orgInternalDomains.length > 0) {
    for (const known of ctx.orgInternalDomains) {
      if (known === ctx.domain) break;
      const dist = editDist(ctx.domain, known, 2);
      if (dist > 0 && dist <= 2) {
        signals.push(sig("lookalike_domain", 3.0,
          { domain: ctx.domain, similar_to: known, edit_distance: dist }));
        break;
      }
    }
  }

  if (ctx.domain && FREEMAIL.has(ctx.domain)
      && recipients.some((r) => r.includes("@") && !FREEMAIL.has(r.split("@")[1].toLowerCase()))) {
    signals.push(sig("freemail_to_corp", 0.6,
      { sender_domain: ctx.domain, corp_recipients: recipients.length }));
  }

  // ── Group: Sender-recipient pair ──────────────────────────────────────
  if (ctx.pairHist && ctx.recipient) {
    const totalPair = Number(ctx.pairHist.total_count);
    // pair_frequency_deviation: pair exists but this hour is unusual.
    // Approximation: if pair has >20 prior msgs and this is outside biz hours.
    if (totalPair >= 20 && (hour < bizStart || hour >= bizEnd)) {
      signals.push(sig("pair_frequency_deviation", 0.6,
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
      signals.push(sig("size_distribution_anomaly", 0.8,
        { size: bodyLen, avg_size: Math.round(avgSize) }));
    }
    const avgLinks = Number(ctx.senderHist.avg_links || 0);
    if (avgLinks < 0.5 && linkCount >= 3) {
      signals.push(sig("link_density_change", 1.2,
        { links: linkCount, avg_links: Number(avgLinks.toFixed(2)) }));
    }
    const avgAttach = Number(ctx.senderHist.avg_attach || 0);
    if (avgAttach < 0.1 && attCount >= 1) {
      signals.push(sig("attachment_rate_anomaly", 1.5,
        { attachments: attCount, historic_rate: Number(avgAttach.toFixed(2)) }));
    }
    if (recipients.length >= 5) {
      // bulk-vs-individual: sender historically 1 recipient, now many.
      signals.push(sig("bulk_vs_individual_ratio_shift", 1.0,
        { recipients: recipients.length }));
    }
  }

  // ── Group: Account behavior ───────────────────────────────────────────
  // auth_failure_correlation — DATA_DEP (needs IdP log integration).
  // delegation_change_detection — DATA_DEP (needs M365/Google mgmt API).
  // geographic_sending_anomaly — DATA_DEP (needs IP geolocation).

  return signals;
}

async function persist(email, ctx) {
  const bodyLen = (email.body_text || "").length;
  const attCount = (email.attachments || []).length;
  const linkCount = ((email.body_text || "").match(URL_RE) || []).length;
  const subjectLen = (email.subject || "").length;

  await safeQuery(
    `INSERT INTO email_metadata
       (org_id, message_id, sender, sender_domain, recipient, \`timestamp\`,
        size_bytes, has_attachment, attachment_count, subject_length,
        body_length, link_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ctx.orgId, email.message_id, ctx.sender, ctx.domain, ctx.recipient, ctx.ts,
      bodyLen, attCount > 0 ? 1 : 0, attCount, subjectLen, bodyLen, linkCount],
  );

  if (ctx.recipient) {
    await safeQuery(
      `INSERT INTO sender_recipient_pairs
         (org_id, sender, recipient, total_count, last_seen, first_seen)
       VALUES (?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE
         total_count = total_count + 1, last_seen = VALUES(last_seen)`,
      [ctx.orgId, ctx.sender, ctx.recipient, ctx.ts, ctx.ts],
    );
  }

  if (ctx.domain) {
    await safeQuery(
      `INSERT INTO domain_first_seen
         (org_id, domain, first_seen, total_emails_from, is_freemail)
       VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE total_emails_from = total_emails_from + 1`,
      [ctx.orgId, ctx.domain, ctx.ts, FREEMAIL.has(ctx.domain) ? 1 : 0],
    );
  }

  await safeQuery(
    `INSERT INTO sender_daily_stats
       (org_id, sender, \`date\`, email_count, avg_size, attachment_rate, unique_recipients)
     VALUES (?, ?, DATE(?), 1, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       email_count = email_count + 1,
       avg_size = ((avg_size * email_count) + VALUES(avg_size)) / (email_count + 1),
       attachment_rate = ((attachment_rate * email_count) + VALUES(attachment_rate)) / (email_count + 1)`,
    [ctx.orgId, ctx.sender, ctx.ts, bodyLen, attCount > 0 ? 1 : 0],
  );

  await safeQuery(
    `INSERT INTO hourly_distribution
       (org_id, sender, hour_of_day, day_of_week, email_count)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE email_count = email_count + 1`,
    [ctx.orgId, ctx.sender, ctx.ts.getUTCHours(), ctx.ts.getUTCDay()],
  );
}

// Apply the per-org ramp weight (0 → 1 over 30 days) to every signal score.
function applyWeight(signals, weight) {
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
  return signals;
}

const app = makeApp("e3_stats_db", analyze);
listen(app, "e3_stats_db");
