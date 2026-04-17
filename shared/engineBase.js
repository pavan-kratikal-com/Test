// Minimal Express scaffold every engine reuses.
//   GET  /health   -> {status, engine}
//   POST /analyze  -> EngineResponse {engine, latency_ms, signals[], error?}
import express from "express";
import { Email } from "./schemas.js";

export function makeApp(engineName, analyzeFn) {
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", engine: engineName });
  });

  app.post("/analyze", async (req, res) => {
    const start = process.hrtime.bigint();
    let parsed;
    try {
      parsed = Email.parse(req.body);
    } catch (err) {
      return res.status(400).json({
        engine: engineName,
        latency_ms: 0,
        signals: [],
        error: `invalid email payload: ${err.message}`,
      });
    }
    try {
      const signals = (await analyzeFn(parsed)) ?? [];
      const latency = Number(process.hrtime.bigint() - start) / 1e6;
      res.json({ engine: engineName, latency_ms: latency, signals });
    } catch (err) {
      const latency = Number(process.hrtime.bigint() - start) / 1e6;
      res.json({
        engine: engineName,
        latency_ms: latency,
        signals: [],
        error: err.message,
      });
    }
  });

  return app;
}

export function listen(app, engineName) {
  if (process.env.ETDP_NO_LISTEN === "1") return null;
  const port = Number(process.env.PORT || 80);
  return app.listen(port, () => {
    console.log(`[${engineName}] listening on :${port}`);
  });
}
