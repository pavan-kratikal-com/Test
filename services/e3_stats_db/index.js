// E3 Stats DB. Phase 1 implementation: 5 of 36 behavioral signals against MySQL.
//
// Signals implemented:
//   first_time_sender         — sender has never emailed this org
//   first_time_pair           — sender has never emailed this recipient
//   domain_first_seen_recent  — sender domain first observed within 48h
//   off_hours_email           — received outside 08:00–20:00 UTC
//   sender_burst              — sender sent >max(5, 3× 7d-avg) in last hour
//
// After signal extraction, the engine persists email_metadata and upserts
// sender_recipient_pairs, domain_first_seen, sender_daily_stats and
// hourly_distribution. All DB errors fail open (no signal fired).
import { makeApp, listen } from "@etdp/shared/engineBase";
import { safeQuery } from "@etdp/shared/mysql";

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

async function extractSignals(email) {
  const signals = [];
  const orgId = email.org_id;
  const sender = email.sender;
  const domain = senderDomain(email);
  const recipient = (email.recipients && email.recipients[0]) || "";
  const ts = receivedAt(email);
  const hour = ts.getUTCHours();

  // 1. first_time_sender
  const fts = await safeQuery(
    "SELECT 1 FROM email_metadata WHERE org_id = ? AND sender = ? LIMIT 1",
    [orgId, sender],
  );
  if (fts.ok && fts.rows.length === 0) {
    signals.push({
      engine: "stats_db", signal: "first_time_sender",
      score: 1.5, detail: { sender },
    });
  }

  // 2. first_time_pair
  if (recipient) {
    const ftp = await safeQuery(
      "SELECT 1 FROM sender_recipient_pairs WHERE org_id=? AND sender=? AND recipient=? LIMIT 1",
      [orgId, sender, recipient],
    );
    if (ftp.ok && ftp.rows.length === 0) {
      signals.push({
        engine: "stats_db", signal: "first_time_pair",
        score: 0.8, detail: { sender, recipient },
      });
    }
  }

  // 3. domain_first_seen_recent (within 48h)
  if (domain) {
    const dom = await safeQuery(
      "SELECT first_seen FROM domain_first_seen WHERE org_id=? AND domain=?",
      [orgId, domain],
    );
    if (dom.ok) {
      if (dom.rows.length === 0) {
        signals.push({
          engine: "stats_db", signal: "domain_first_seen",
          score: 1.2, detail: { domain },
        });
      } else {
        const ageMs = Date.now() - new Date(dom.rows[0].first_seen).getTime();
        if (ageMs < 48 * 3600 * 1000) {
          signals.push({
            engine: "stats_db", signal: "domain_first_seen_recent",
            score: 1.0, detail: { domain, age_hours: Math.round(ageMs / 3.6e6) },
          });
        }
      }
    }
  }

  // 4. off_hours_email (UTC 08–20 = business window)
  if (hour < 8 || hour >= 20) {
    signals.push({
      engine: "stats_db", signal: "off_hours_email",
      score: 0.5, detail: { hour_utc: hour },
    });
  }

  // 5. sender_burst (last hour vs 7d average)
  const burst = await safeQuery(
    "SELECT COUNT(*) AS c FROM email_metadata WHERE org_id=? AND sender=? AND `timestamp` > NOW() - INTERVAL 1 HOUR",
    [orgId, sender],
  );
  const avg = await safeQuery(
    "SELECT AVG(email_count) AS avg_cnt FROM sender_daily_stats WHERE org_id=? AND sender=? AND `date` > DATE_SUB(CURDATE(), INTERVAL 7 DAY)",
    [orgId, sender],
  );
  if (burst.ok && avg.ok) {
    const lastHour = Number(burst.rows[0]?.c || 0);
    const avgDaily = Number(avg.rows[0]?.avg_cnt || 0);
    const threshold = Math.max(5, avgDaily * 3);
    if (lastHour > threshold) {
      signals.push({
        engine: "stats_db", signal: "sender_burst",
        score: 2.5, detail: { last_hour: lastHour, avg_daily: avgDaily, threshold },
      });
    }
  }

  return signals;
}

async function persist(email) {
  const orgId = email.org_id;
  const sender = email.sender;
  const domain = senderDomain(email);
  const recipient = (email.recipients && email.recipients[0]) || "";
  const ts = receivedAt(email);
  const linkCount = ((email.body_text || "").match(URL_RE) || []).length;
  const attCount = (email.attachments || []).length;
  const subjectLen = (email.subject || "").length;
  const bodyLen = (email.body_text || "").length;

  await safeQuery(
    `INSERT INTO email_metadata
       (org_id, message_id, sender, sender_domain, recipient, \`timestamp\`,
        size_bytes, has_attachment, attachment_count, subject_length,
        body_length, link_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, email.message_id, sender, domain, recipient, ts,
      bodyLen, attCount > 0 ? 1 : 0, attCount, subjectLen, bodyLen, linkCount],
  );

  if (recipient) {
    await safeQuery(
      `INSERT INTO sender_recipient_pairs
         (org_id, sender, recipient, total_count, last_seen, first_seen)
       VALUES (?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE
         total_count = total_count + 1,
         last_seen = VALUES(last_seen)`,
      [orgId, sender, recipient, ts, ts],
    );
  }

  if (domain) {
    await safeQuery(
      `INSERT INTO domain_first_seen
         (org_id, domain, first_seen, total_emails_from, is_freemail)
       VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         total_emails_from = total_emails_from + 1`,
      [orgId, domain, ts, FREEMAIL.has(domain) ? 1 : 0],
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
    [orgId, sender, ts, bodyLen, attCount > 0 ? 1 : 0],
  );

  await safeQuery(
    `INSERT INTO hourly_distribution
       (org_id, sender, hour_of_day, day_of_week, email_count)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE email_count = email_count + 1`,
    [orgId, sender, ts.getUTCHours(), ts.getUTCDay()],
  );
}

async function analyze(email) {
  const signals = await extractSignals(email);
  await persist(email);
  return signals;
}

const app = makeApp("e3_stats_db", analyze);
listen(app, "e3_stats_db");
