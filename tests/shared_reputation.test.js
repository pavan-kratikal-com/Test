import test from "node:test";
import assert from "node:assert/strict";

// Ensure Redis disabled (so cache is a no-op) and PhishTank is the stub
// offline fallback.  We don't exercise real network.
delete process.env.REDIS_URL;
delete process.env.REDIS_HOST;
delete process.env.GOOGLE_SAFE_BROWSING_API_KEY;
process.env.PHISHTANK_URL = "http://127.0.0.1:1/nope.json";

const mod = await import("../shared/reputation.js");
const { seedBlocklist, phishTankLookup, reputationSignals, safeBrowsingLookup } = mod;

test("seedBlocklist is a non-empty Set of known-bad domains", () => {
  const s = seedBlocklist();
  assert.ok(s.size >= 3);
  assert.ok(s.has("login-microsft.top"));
});

test("phishTankLookup: hits seed list when feed is unreachable", async () => {
  const r = await phishTankLookup("login-microsft.top");
  assert.equal(r.hit, true);
});

test("phishTankLookup: miss on an unrelated host", async () => {
  const r = await phishTankLookup("example.com");
  assert.equal(r.hit, false);
});

test("safeBrowsingLookup: skips when no API key is configured", async () => {
  const r = await safeBrowsingLookup(["https://example.com/"]);
  assert.deepEqual(r, { matches: [] });
});

test("reputationSignals: emits PhishTank hit for seeded host", async () => {
  const s = await reputationSignals("https://login-microsft.top/auth");
  assert.ok(s.find((x) => x.signal === "reputation_phishtank_hit"));
});

test("reputationSignals: no signals for benign URL", async () => {
  const s = await reputationSignals("https://example.com/");
  assert.equal(s.length, 0);
});

test("reputationSignals: swallows URL parse errors", async () => {
  const s = await reputationSignals("not a url");
  assert.equal(s.length, 0);
});
