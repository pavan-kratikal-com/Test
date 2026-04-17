// Deep path worker — consumes {email, fast_signals, org_context} off Kafka,
// runs the deep engines, synthesizes a verdict, and UPSERTs the updated
// verdict row into the org's DB (replacing the initial quarantine record
// the gateway wrote).
import { request } from "undici";
import { makeConsumer, TOPIC_DEEP_PATH, kafkaEnabled } from "@etdp/shared/kafka";
import { safeOrgQuery } from "@etdp/shared/mysql";

const DEEP_ENGINES = ["e5_url_scanner", "e6_attachment", "e7_visual", "e9_specialized_ml"];
const ENGINE_HOSTS = Object.fromEntries(
  [...DEEP_ENGINES, "synthesizer"].map((n) => [
    n, process.env[`${n.toUpperCase()}_URL`] || `http://${n}:80`,
  ]),
);

async function callEngine(name, email) {
  const url = `${ENGINE_HOSTS[name]}/analyze`;
  try {
    const { statusCode, body } = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(email),
      bodyTimeout: 30_000,
      headersTimeout: 30_000,
    });
    const text = await body.text();
    if (statusCode >= 400) return { signals: [], error: `HTTP ${statusCode}` };
    return JSON.parse(text);
  } catch (err) { return { signals: [], error: err.message }; }
}

function reassess(allSignals, thresholds, weights) {
  let total = 0;
  for (const s of allSignals) {
    let w = 1;
    if (/phish|dmarc|credential/i.test(s.signal)) w = weights.phishing;
    if (/malware|macro|pe_|dangerous/i.test(s.signal)) w = weights.malware;
    if (/wire|transfer|bec|urgency/i.test(s.signal)) w = weights.bec;
    total += (s.score || 0) * w;
  }
  const blockAt = Number(thresholds.block ?? 10);
  const qAt = Number(thresholds.quarantine ?? 5);
  if (total >= blockAt) {
    return { total, label: "phishing", verdict: "block",
      reason: `Deep path confirmed ${total.toFixed(1)} ≥ ${blockAt}.` };
  }
  if (total >= qAt) {
    return { total, label: "spam", verdict: "quarantine",
      reason: `Deep path inconclusive (${total.toFixed(1)}).` };
  }
  return { total, label: "ham", verdict: "allow",
    reason: "Deep path cleared the email." };
}

async function processMessage(message) {
  const payload = JSON.parse(message.value.toString());
  const { email, fast_signals, org_context } = payload;
  const t0 = process.hrtime.bigint();

  const results = await Promise.all(DEEP_ENGINES.map((e) => callEngine(e, {
    ...email, prior_signals: fast_signals,
  })));
  const deepSignals = results.flatMap((r) => r.signals || []);
  const allSignals = [...(fast_signals || []), ...deepSignals];

  const weights = org_context?.industry_weights || { bec: 1, phishing: 1, malware: 1 };
  const thresholds = org_context?.thresholds || { block: 10, quarantine: 5 };
  const agg = reassess(allSignals, thresholds, weights);
  const deepMs = Number(process.hrtime.bigint() - t0) / 1e6;

  await safeOrgQuery(email.org_id,
    `UPDATE verdicts
     SET verdict=?, label=?, confidence=?, threat_score=?, reason=?,
         signals=?, deep_path_ms=?
     WHERE org_id=? AND message_id=?`,
    [agg.verdict, agg.label, Math.min(agg.total / 15, 1), agg.total, agg.reason,
      JSON.stringify(allSignals), deepMs, email.org_id, email.message_id],
  );
  console.log(`[deep] ${email.message_id} ${agg.verdict} (${agg.total.toFixed(1)}) in ${deepMs.toFixed(0)}ms`);
}

async function main() {
  if (!kafkaEnabled()) {
    console.log("[deep] KAFKA_BROKERS not set — worker exiting (gateway will sync-fallback)");
    process.exit(0);
  }
  const consumer = makeConsumer("etdp-deep-path");
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC_DEEP_PATH, fromBeginning: false });
  console.log(`[deep] consuming ${TOPIC_DEEP_PATH}`);
  await consumer.run({
    eachMessage: async ({ message }) => {
      try { await processMessage(message); }
      catch (err) { console.error("[deep]", err.message); }
    },
  });
}

main();
