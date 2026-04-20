// shared/cache.js no-op fallback tests (runs without Redis).
import test from "node:test";
import assert from "node:assert/strict";
import { cacheGet, cacheSet, cached } from "../shared/cache.js";

// No REDIS_URL / REDIS_HOST set → every call becomes a no-op / passthrough.
delete process.env.REDIS_URL;
delete process.env.REDIS_HOST;

test("cacheGet returns null when Redis is unconfigured", async () => {
  assert.equal(await cacheGet("any-key"), null);
});

test("cacheSet is a no-op when Redis is unconfigured", async () => {
  await cacheSet("k", "v", 60);  // should not throw
});

test("cached() always invokes loader when cache unavailable", async () => {
  let calls = 0;
  const loader = async () => { calls += 1; return { result: "x" }; };
  const a = await cached("k1", 60, loader);
  const b = await cached("k1", 60, loader);
  assert.deepEqual(a, { result: "x" });
  assert.deepEqual(b, { result: "x" });
  assert.equal(calls, 2);
});
