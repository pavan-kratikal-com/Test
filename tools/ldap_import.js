#!/usr/bin/env node
// Import directory data (LDAP / AD / mock) into an org's graph_nodes
// and graph_display_names tables.
//
// Usage:
//   LDAP_MOCK_FILE=examples/ldap_mock.json \
//     node tools/ldap_import.js --org org_demo_001
//
// With a real LDAP provider (future):
//   LDAP_PROVIDER=ldap LDAP_URL=ldaps://dc1.example.com:636 \
//     LDAP_BIND_DN=... LDAP_BIND_PASSWORD=... \
//     node tools/ldap_import.js --org org_demo_001
//
// Upserts:
//   - graph_nodes        (address, display_name, is_internal, department, title)
//   - graph_display_names (normalized_name, canonical_address, is_vip)
import { makeLdapClient } from "@etdp/shared/ldap";
import { safeOrgQuery } from "@etdp/shared/mysql";

const argv = process.argv.slice(2);
function arg(n, f) { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : f; }
const orgId = arg("--org");
if (!orgId) { console.error("--org required"); process.exit(2); }

const client = makeLdapClient();
const users = await client.listUsers();
console.log(`[ldap] loaded ${users.length} users`);

function normName(display) {
  return (display || "").toLowerCase().trim().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ");
}

let upsertedNodes = 0, upsertedDisplays = 0;
const now = new Date();

for (const u of users) {
  const r = await safeOrgQuery(orgId,
    `INSERT INTO graph_nodes
       (org_id, address, display_name, is_internal, department, title, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       display_name = VALUES(display_name),
       is_internal  = VALUES(is_internal),
       department   = VALUES(department),
       title        = VALUES(title),
       last_seen    = VALUES(last_seen)`,
    [orgId, u.address, u.display_name, u.is_internal ? 1 : 0,
      u.department, u.title, now, now],
  );
  if (r.ok) upsertedNodes++;

  if (u.display_name) {
    const nn = normName(u.display_name);
    const d = await safeOrgQuery(orgId,
      `INSERT INTO graph_display_names
         (org_id, normalized_name, canonical_address, is_vip)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         canonical_address = VALUES(canonical_address),
         is_vip            = VALUES(is_vip)`,
      [orgId, nn, u.address, u.is_vip ? 1 : 0],
    );
    if (d.ok) upsertedDisplays++;
  }
}

console.log(`[ldap] ${orgId}: upserted ${upsertedNodes} nodes, ${upsertedDisplays} display names`);
