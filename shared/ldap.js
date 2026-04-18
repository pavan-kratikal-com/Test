// Pluggable directory-service connector.
//
// Providers:
//   "mock"   — reads a JSON file at LDAP_MOCK_FILE. Tests / local dev.
//   "ldap"   — placeholder for a real ldapjs / active-directory binding
//              (not wired in Phase 2 — docs below).
//
// The interface is small: listUsers() returns every identity we want to
// ingest into graph_nodes, and listVips() returns the subset whose display
// names should be treated as exec impersonation magnets.
//
// User record shape:
//   {
//     address:      "alice@acmecorp.com",
//     display_name: "Alice Smith",
//     department:   "Finance",
//     title:        "CFO",
//     is_internal:  true,
//     is_vip:       false
//   }
import { readFile } from "node:fs/promises";

function normalizeUser(u) {
  return {
    address: String(u.address || u.mail || "").toLowerCase(),
    display_name: u.display_name || u.displayName || u.cn || "",
    department: u.department || null,
    title: u.title || null,
    is_internal: u.is_internal ?? true,
    is_vip: Boolean(u.is_vip ?? u.vip ?? false),
  };
}

export class MockLdapClient {
  constructor(filePath) { this.filePath = filePath; }
  async _load() {
    const raw = await readFile(this.filePath, "utf8");
    const data = JSON.parse(raw);
    return (data.users || []).map(normalizeUser).filter((u) => u.address);
  }
  async listUsers() { return this._load(); }
  async listVips() { return (await this._load()).filter((u) => u.is_vip); }
}

// Placeholder for real AD/LDAP — keep the surface minimal so a future
// ldapjs binding drops in without the callers changing.
// Deployment notes:
//   1. `npm install ldapjs` (kept out of scaffold to avoid heavy deps).
//   2. set LDAP_URL=ldaps://dc1.corp.example.com:636
//          LDAP_BIND_DN=CN=etdp-svc,OU=Service,DC=corp,DC=example,DC=com
//          LDAP_BIND_PASSWORD=...
//          LDAP_USER_BASE=OU=People,DC=corp,DC=example,DC=com
//   3. Rebuild with LDAP_PROVIDER=ldap.
export class LdapClient {
  constructor() {
    throw new Error("real LDAP provider not implemented in Phase 2 — see shared/ldap.js");
  }
}

export function makeLdapClient({ provider = process.env.LDAP_PROVIDER || "mock" } = {}) {
  if (provider === "mock") {
    const path = process.env.LDAP_MOCK_FILE;
    if (!path) throw new Error("LDAP_MOCK_FILE env var required for mock provider");
    return new MockLdapClient(path);
  }
  if (provider === "ldap") return new LdapClient();
  throw new Error(`unknown LDAP_PROVIDER: ${provider}`);
}
