import test from "node:test";
import assert from "node:assert/strict";
import { domainMetaSignals } from "../shared/whois.js";

test("domainMetaSignals: fires domain_unresolvable when resolves=false", () => {
  const s = domainMetaSignals({ hostname: "noexist.tld", resolves: false });
  assert.ok(s.find((x) => x.signal === "domain_unresolvable"));
});

test("domainMetaSignals: fires domain_no_mail_infra when no MX/SPF/DMARC", () => {
  const s = domainMetaSignals({
    hostname: "x.com", resolves: true, has_mx: false,
    has_spf: false, has_dmarc: false,
  });
  assert.ok(s.find((x) => x.signal === "domain_no_mail_infra"));
});

test("domainMetaSignals: fires domain_appears_parked", () => {
  const s = domainMetaSignals({
    hostname: "parked.xyz", resolves: true, has_mx: false,
    has_spf: false, appears_parked: true,
  });
  assert.ok(s.find((x) => x.signal === "domain_appears_parked"));
});

test("domainMetaSignals: healthy domain (MX + SPF) produces nothing", () => {
  const s = domainMetaSignals({
    hostname: "example.com", resolves: true, has_mx: true,
    has_spf: true, has_dmarc: true,
  });
  assert.equal(s.length, 0);
});

test("domainMetaSignals: null input returns empty array", () => {
  assert.deepEqual(domainMetaSignals(null), []);
});
