// Model registry helpers — CRUD on org_models + model_deployments.
import { safeQuery, safeOrgQuery } from "./mysql.js";

export async function insertModel({
  orgId, version, kind = "logistic",
  weights, intercept, featureNames,
  valAccuracy, valPrecision, valRecall, valFpRate,
  trainedOn, parentVersion = null,
}) {
  return safeQuery(
    `INSERT INTO org_models
       (org_id, version, model_kind, weights, intercept, feature_names,
        val_accuracy, val_precision, val_recall, val_fp_rate,
        trained_on, status, parent_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'trained', ?)`,
    [orgId, version, kind, JSON.stringify(weights), intercept,
      JSON.stringify(featureNames), valAccuracy, valPrecision, valRecall, valFpRate,
      trainedOn, parentVersion],
  );
}

export async function getModel(orgId, version) {
  const r = await safeQuery(
    `SELECT * FROM org_models WHERE org_id=? AND version=? LIMIT 1`,
    [orgId, version],
  );
  if (!r.ok || r.rows.length === 0) return null;
  return hydrate(r.rows[0]);
}

export async function deployAsIncumbent(orgId, version) {
  // Retire the current incumbent, then set the new one at 100%.
  await safeQuery(
    `UPDATE org_models SET status='retired' WHERE org_id=? AND status='active'`,
    [orgId],
  );
  await safeQuery(
    `UPDATE org_models SET status='active' WHERE org_id=? AND version=?`,
    [orgId, version],
  );
  await safeQuery(
    `INSERT INTO model_deployments (org_id, role, model_version, traffic_pct)
     VALUES (?, 'incumbent', ?, 100)
     ON DUPLICATE KEY UPDATE model_version=VALUES(model_version), traffic_pct=100,
       deployed_at=NOW(3)`,
    [orgId, version],
  );
  await safeQuery(
    `DELETE FROM model_deployments WHERE org_id=? AND role='canary'`,
    [orgId],
  );
}

export async function deployAsCanary(orgId, version, trafficPct = 10) {
  await safeQuery(
    `INSERT INTO model_deployments (org_id, role, model_version, traffic_pct)
     VALUES (?, 'canary', ?, ?)
     ON DUPLICATE KEY UPDATE model_version=VALUES(model_version),
       traffic_pct=VALUES(traffic_pct), deployed_at=NOW(3)`,
    [orgId, version, Math.max(0, Math.min(100, trafficPct))],
  );
}

export async function rollback(orgId, reason) {
  // Remove canary; mark canary model as rolled_back.
  const canary = await safeQuery(
    `SELECT model_version FROM model_deployments WHERE org_id=? AND role='canary' LIMIT 1`,
    [orgId],
  );
  if (canary.ok && canary.rows.length > 0) {
    const v = canary.rows[0].model_version;
    await safeQuery(
      `UPDATE org_models SET status='rolled_back' WHERE org_id=? AND version=?`,
      [orgId, v],
    );
    await safeQuery(
      `DELETE FROM model_deployments WHERE org_id=? AND role='canary'`, [orgId],
    );
    return { ok: true, rolled_back_version: v, reason };
  }
  return { ok: false, reason: "no canary to roll back" };
}

export async function getDeployments(orgId) {
  const r = await safeQuery(
    `SELECT d.role, d.model_version, d.traffic_pct, m.weights, m.intercept, m.feature_names
     FROM model_deployments d
     JOIN org_models m ON d.org_id=m.org_id AND d.model_version=m.version
     WHERE d.org_id=?`,
    [orgId],
  );
  if (!r.ok) return [];
  return r.rows.map(hydrate);
}

export async function listJobs(orgId, limit = 20) {
  const r = await safeQuery(
    `SELECT id, started_at, finished_at, status, labels_used,
            resulting_version, notes
     FROM training_jobs WHERE org_id=? ORDER BY started_at DESC LIMIT ?`,
    [orgId, limit],
  );
  return r.ok ? r.rows : [];
}

export async function logJob(orgId, { status, labelsUsed, resultingVersion = null, notes = null }) {
  const r = await safeQuery(
    `INSERT INTO training_jobs (org_id, finished_at, status, labels_used, resulting_version, notes)
     VALUES (?, NOW(3), ?, ?, ?, ?)`,
    [orgId, status, labelsUsed, resultingVersion, notes],
  );
  return r.ok ? r.rows.insertId : null;
}

// Gather the last N labeled emails for an org (joins feedback_labels with
// verdicts to get the signal vector) — used by the trainer.
export async function gatherTrainingData(orgId, limit = 500) {
  const r = await safeOrgQuery(orgId,
    `SELECT v.signals, f.action
     FROM feedback_labels f
     JOIN verdicts v ON v.org_id=f.org_id AND v.message_id=f.message_id
     WHERE f.org_id=? AND f.action IN ('ham','spam','phishing','not_spam','confirm_block')
     ORDER BY f.created_at DESC LIMIT ?`,
    [orgId, limit],
  );
  if (!r.ok) return [];
  return r.rows.map((row) => {
    const signals = typeof row.signals === "string" ? JSON.parse(row.signals) : row.signals;
    // Binary label: 1 = threat (phishing / spam / confirm_block), 0 = benign.
    const threat = /phishing|confirm_block|spam/i.test(row.action)
      && !/not_spam/i.test(row.action) ? 1 : 0;
    return { signals, label: threat };
  });
}

function hydrate(row) {
  return {
    ...row,
    weights: typeof row.weights === "string" ? JSON.parse(row.weights) : row.weights,
    feature_names: typeof row.feature_names === "string"
      ? JSON.parse(row.feature_names) : row.feature_names,
  };
}
