// Kafka wrapper tests — verify the graceful no-op behavior when brokers
// are not configured (dev mode without docker/kafka running).
import test from "node:test";
import assert from "node:assert/strict";

delete process.env.KAFKA_BROKERS;
const { produce, kafkaEnabled, TOPIC_DEEP_PATH, makeConsumer } =
  await import("../shared/kafka.js");

test("kafkaEnabled: false when KAFKA_BROKERS is unset", () => {
  assert.equal(kafkaEnabled(), false);
});

test("TOPIC_DEEP_PATH has a sensible default", () => {
  assert.equal(TOPIC_DEEP_PATH, "etdp.deep_path");
});

test("produce: returns {ok:false, reason:'kafka_unavailable'} when disabled", async () => {
  const r = await produce("any.topic", "k", { v: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "kafka_unavailable");
});

test("makeConsumer: returns null when brokers are unset", () => {
  assert.equal(makeConsumer("any-group"), null);
});
