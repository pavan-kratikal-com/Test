import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockLdapClient, makeLdapClient } from "../shared/ldap.js";

const tmp = join(tmpdir(), `ldap-mock-${Date.now()}.json`);

test.before(async () => {
  await writeFile(tmp, JSON.stringify({
    users: [
      { address: "Alice@ACME.COM", display_name: "Alice", is_vip: true, department: "Finance" },
      { mail: "bob@acme.com", displayName: "Bob", title: "Engineer" },
      { address: "", display_name: "blank" }, // should be filtered
    ],
  }));
});

test.after(async () => { try { await unlink(tmp); } catch {} });

test("MockLdapClient.listUsers normalizes field names and lowercases addresses", async () => {
  const client = new MockLdapClient(tmp);
  const users = await client.listUsers();
  assert.equal(users.length, 2);
  assert.equal(users[0].address, "alice@acme.com");
  assert.equal(users[0].is_vip, true);
  assert.equal(users[0].department, "Finance");
  assert.equal(users[1].address, "bob@acme.com");
  assert.equal(users[1].display_name, "Bob");
  assert.equal(users[1].is_vip, false); // default
});

test("MockLdapClient.listVips filters to VIP users only", async () => {
  const client = new MockLdapClient(tmp);
  const vips = await client.listVips();
  assert.equal(vips.length, 1);
  assert.equal(vips[0].address, "alice@acme.com");
});

test("makeLdapClient: mock provider reads from LDAP_MOCK_FILE", async () => {
  process.env.LDAP_PROVIDER = "mock";
  process.env.LDAP_MOCK_FILE = tmp;
  const client = makeLdapClient();
  const users = await client.listUsers();
  assert.equal(users.length, 2);
});

test("makeLdapClient: unknown provider throws", () => {
  assert.throws(() => makeLdapClient({ provider: "nonexistent" }),
    /unknown LDAP_PROVIDER/);
});
