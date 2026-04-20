#!/usr/bin/env node
// Manual rollback: removes the canary deployment and marks the model
// rolled_back, keeping the current incumbent in place.
//
//   node tools/rollback.js --org <org_id> [--reason "metrics regressed"]
import { rollback, logJob } from "@etdp/shared/modelRegistry";

const argv = process.argv.slice(2);
function arg(n, f) { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : f; }

const orgId = arg("--org");
if (!orgId) { console.error("--org required"); process.exit(2); }
const reason = arg("--reason", "manual");

const result = await rollback(orgId, reason);
console.log(JSON.stringify(result, null, 2));
if (result.ok) {
  await logJob(orgId, { status: "rolled_back", labelsUsed: 0,
    resultingVersion: result.rolled_back_version, notes: `manual: ${reason}` });
}
