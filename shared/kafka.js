// Kafka client wrapper used by gateway (producer) and deep_path_worker (consumer).
//
// Gracefully no-ops / reports unavailable when brokers aren't configured,
// so dev without Kafka continues to work via gateway's sync fallback.
import { Kafka, logLevel } from "kafkajs";

const BROKERS = (process.env.KAFKA_BROKERS || "").split(",").filter(Boolean);
const CLIENT_ID = process.env.KAFKA_CLIENT_ID || "etdp";

export const TOPIC_DEEP_PATH = process.env.KAFKA_TOPIC_DEEP_PATH || "etdp.deep_path";

let kafka = null;
let producer = null;
let producerConnecting = null;

function getClient() {
  if (BROKERS.length === 0) return null;
  if (kafka) return kafka;
  kafka = new Kafka({
    clientId: CLIENT_ID,
    brokers: BROKERS,
    logLevel: logLevel.NOTHING,
    retry: { retries: 3, initialRetryTime: 200 },
  });
  return kafka;
}

export function kafkaEnabled() {
  return BROKERS.length > 0;
}

async function getProducer() {
  const client = getClient();
  if (!client) return null;
  if (producer) return producer;
  if (producerConnecting) return producerConnecting;
  producerConnecting = (async () => {
    const p = client.producer({ allowAutoTopicCreation: true });
    try {
      await p.connect();
      producer = p;
      return p;
    } catch (err) {
      producer = null;
      return null;
    } finally {
      producerConnecting = null;
    }
  })();
  return producerConnecting;
}

export async function produce(topic, key, value) {
  const p = await getProducer();
  if (!p) return { ok: false, reason: "kafka_unavailable" };
  try {
    await p.send({
      topic,
      messages: [{ key: String(key), value: JSON.stringify(value) }],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function makeConsumer(groupId) {
  const client = getClient();
  if (!client) return null;
  return client.consumer({ groupId });
}

export async function shutdown() {
  if (producer) { try { await producer.disconnect(); } catch {} producer = null; }
}
