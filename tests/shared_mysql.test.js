// Pure-logic tests for the multi-tenant mysql helper. We can't easily
// spin up MySQL in unit tests, but orgDbName() is a pure function worth
// verifying, and getOrgPool() in single-tenant fallback mode is testable.
import test from "node:test";
import assert from "node:assert/strict";

// Force single-tenant mode so getOrgPool() reuses the shared pool.
process.env.MYSQL_MULTI_TENANT = "0";
const { orgDbName, getOrgPool, getSharedPool } = await import("../shared/mysql.js");

test("orgDbName: sanitizes uppercase, special chars, length", () => {
  assert.equal(orgDbName("org_demo_001"), "etdp_org_org_demo_001");
  assert.equal(orgDbName("Org-With-Dashes"), "etdp_org_org_with_dashes");
  assert.equal(orgDbName("ACME CORP.IN"), "etdp_org_acme_corp_in");
  // Long IDs are truncated to 40 chars post-prefix.
  const long = "a".repeat(60);
  const name = orgDbName(long);
  assert.equal(name.length, "etdp_org_".length + 40);
  assert.ok(name.startsWith("etdp_org_"));
});

test("orgDbName: respects MYSQL_ORG_PREFIX env (via direct call)", () => {
  // Can't mutate prefix post-import, but ensure default is stable.
  assert.match(orgDbName("x"), /^etdp_org_/);
});

test("getOrgPool in single-tenant mode returns the shared pool", () => {
  const a = getSharedPool();
  const b = getOrgPool("org_a");
  const c = getOrgPool("org_b");
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
});
