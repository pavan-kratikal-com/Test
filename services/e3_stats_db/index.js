// E3 Stats DB stub. Real impl: MySQL + Redis cache, 36 behavioral signals
// (sender volume, time-of-day, recipient anomaly, domain first-seen, etc).
import mysql from "mysql2/promise";
import { makeApp, listen } from "@etdp/shared/engineBase";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "mysql",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "etdp",
  password: process.env.MYSQL_PASSWORD || "etdp",
  database: process.env.MYSQL_DATABASE || "etdp",
  waitForConnections: true,
  connectionLimit: 10,
});

async function isFirstTimeSender(orgId, sender) {
  try {
    const [rows] = await pool.query(
      "SELECT 1 FROM email_metadata WHERE org_id = ? AND sender = ? LIMIT 1",
      [orgId, sender],
    );
    return rows.length === 0;
  } catch {
    // DB not ready / table missing — fail open in scaffold mode.
    return true;
  }
}

async function recordEmail(email) {
  try {
    const domain = email.sender.includes("@") ? email.sender.split("@")[1] : "";
    await pool.query(
      `INSERT INTO email_metadata
       (org_id, message_id, sender, sender_domain, recipient, \`timestamp\`,
        size_bytes, has_attachment, attachment_count, subject_length, body_length, link_count)
       VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, 0)`,
      [
        email.org_id,
        email.message_id,
        email.sender,
        domain,
        (email.recipients && email.recipients[0]) || "",
        (email.body_text || "").length,
        (email.attachments || []).length > 0,
        (email.attachments || []).length,
        (email.subject || "").length,
        (email.body_text || "").length,
      ],
    );
  } catch {
    // ignore in scaffold mode
  }
}

async function analyze(email) {
  const signals = [];
  if (email.sender.includes("@") && await isFirstTimeSender(email.org_id, email.sender)) {
    signals.push({
      engine: "stats_db",
      signal: "first_time_sender",
      score: 1.5,
      detail: { sender: email.sender },
    });
  }
  await recordEmail(email);
  return signals;
}

const app = makeApp("e3_stats_db", analyze);
listen(app, "e3_stats_db");
