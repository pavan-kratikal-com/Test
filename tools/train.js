#!/usr/bin/env node
// Per-org model training CLI.
//
//   node tools/train.js --org <org_id> [--canary <pct>] [--min-labels N]
//
// Reads labeled verdicts from the org's DB (via gatherTrainingData),
// fits a logistic-regression classifier on the signal feature vector,
// evaluates on a held-out 20% split, and — if accuracy ≥ previous
// incumbent — deploys the new version as a canary at the configured
// traffic %.  If accuracy regresses, marks the job failed.
import { signalsToFeatures, FEATURE_NAMES } from "@etdp/shared/features";
import { trainLogistic, evaluate, trainValSplit, predictProba } from "@etdp/shared/logreg";
import {
  gatherTrainingData, insertModel, getModel, getDeployments,
  deployAsIncumbent, deployAsCanary, logJob,
} from "@etdp/shared/modelRegistry";
import { safeQuery } from "@etdp/shared/mysql";

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

const orgId = arg("--org");
if (!orgId) { console.error("--org required"); process.exit(2); }

const canaryPct = Number(arg("--canary", "10"));
const minLabels = Number(arg("--min-labels", "20"));
const autoIncumbent = argv.includes("--deploy-incumbent");

const samples = await gatherTrainingData(orgId, 1000);
if (samples.length < minLabels) {
  console.log(`[train] not enough labels for ${orgId}: ${samples.length} < ${minLabels}`);
  await logJob(orgId, { status: "failed", labelsUsed: samples.length,
    notes: "insufficient_labels" });
  process.exit(0);
}

// Extract features + labels.
const X = samples.map((s) => signalsToFeatures(s.signals));
const y = samples.map((s) => s.label);
const paired = X.map((features, i) => ({ features, label: y[i] }));

// Need both classes in training set.
const posCount = y.filter((v) => v === 1).length;
const negCount = y.length - posCount;
if (posCount === 0 || negCount === 0) {
  console.log(`[train] need both classes (pos=${posCount}, neg=${negCount})`);
  await logJob(orgId, { status: "failed", labelsUsed: samples.length,
    notes: "single_class_training_set" });
  process.exit(0);
}

const { train, val } = trainValSplit(paired);
const Xtrain = train.map((p) => p.features);
const ytrain = train.map((p) => p.label);
const Xval = val.map((p) => p.features);
const yval = val.map((p) => p.label);

const model = trainLogistic(Xtrain, ytrain, { epochs: 300, lr: 0.2, l2: 0.01 });
const metrics = evaluate(model.weights, model.intercept, Xval, yval);
console.log(`[train] ${orgId}: n=${samples.length} val_acc=${metrics.accuracy.toFixed(3)} ` +
            `P=${metrics.precision.toFixed(3)} R=${metrics.recall.toFixed(3)} ` +
            `FP=${metrics.fp_rate.toFixed(3)}`);

const version = `v${Math.floor(Date.now() / 1000)}`;
const incumbent = (await getDeployments(orgId)).find((d) => d.role === "incumbent");
await insertModel({
  orgId, version, kind: "logistic",
  weights: model.weights, intercept: model.intercept, featureNames: FEATURE_NAMES,
  valAccuracy: metrics.accuracy, valPrecision: metrics.precision,
  valRecall: metrics.recall, valFpRate: metrics.fp_rate,
  trainedOn: samples.length, parentVersion: incumbent?.model_version || null,
});

// Auto-rollback if the new model is WORSE than the incumbent (regression).
if (incumbent && Number(incumbent.val_accuracy || 0) > metrics.accuracy + 0.02) {
  console.log(`[train] regression: new ${metrics.accuracy.toFixed(3)} < incumbent ${Number(incumbent.val_accuracy).toFixed(3)} — not deploying`);
  await safeQuery(`UPDATE org_models SET status='rolled_back' WHERE org_id=? AND version=?`,
    [orgId, version]);
  await logJob(orgId, { status: "rolled_back", labelsUsed: samples.length,
    resultingVersion: version, notes: `val_acc regression vs ${incumbent.model_version}` });
  process.exit(0);
}

// First model ever → straight-to-incumbent. Otherwise → canary.
if (!incumbent || autoIncumbent) {
  await deployAsIncumbent(orgId, version);
  console.log(`[train] ${orgId} → incumbent ${version}`);
} else {
  await deployAsCanary(orgId, version, canaryPct);
  console.log(`[train] ${orgId} → canary ${version} @ ${canaryPct}%`);
}

await logJob(orgId, { status: "success", labelsUsed: samples.length,
  resultingVersion: version,
  notes: incumbent ? `canary@${canaryPct}%` : "first_model" });
