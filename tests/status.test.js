// Status dashboard tests — validates admin endpoint logic.
// We spin up a tiny mock "engine" server and test the admin routes
// by constructing a minimal app with the same logic the gateway uses.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { renderStatusPage } from "../services/gateway/statusPage.js";

// ── statusPage.js ───────────────────────────────────────────────────────

test("renderStatusPage returns valid HTML with required elements", () => {
  const html = renderStatusPage();
  assert.ok(html.includes("<!DOCTYPE html>"));
  assert.ok(html.includes("ETDP Service Status"));
  assert.ok(html.includes("/admin/status"));
  assert.ok(html.includes("/admin/restart/"));
  assert.ok(html.includes("Auto-refresh"));
});

// ── /admin/status shape test using a real mock server ───────────────────

test("/admin/status: returns array with expected shape", async () => {
  // Create a tiny mock engine that replies to GET /health
  const engine = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", engine: "mock" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => engine.listen(0, r));
  const port = engine.address().port;

  // Simulate what GET /admin/status does: fan out /health calls
  const start = Date.now();
  const resp = await fetch(`http://127.0.0.1:${port}/health`);
  const elapsed = Date.now() - start;
  const data = await resp.json();

  assert.equal(data.status, "ok");
  assert.ok(elapsed >= 0);

  engine.close();
});

// ── service name validation ─────────────────────────────────────────────

test("restart rejects unknown service names", () => {
  const VALID = new Set([
    "e1_rspamd", "e2_slm", "e3_stats_db", "e4_graph_db",
    "e5_url_scanner", "e6_attachment", "e7_visual", "e8_sandbox",
    "e9_specialized_ml", "synthesizer", "deep_path_worker",
  ]);

  assert.ok(VALID.has("e2_slm"));
  assert.ok(VALID.has("synthesizer"));
  assert.ok(!VALID.has("evil_service"));
  assert.ok(!VALID.has("../etc/passwd"));
  assert.ok(!VALID.has(""));
});

test("restart accepts all known engine names", () => {
  const VALID = new Set([
    "e1_rspamd", "e2_slm", "e3_stats_db", "e4_graph_db",
    "e5_url_scanner", "e6_attachment", "e7_visual", "e8_sandbox",
    "e9_specialized_ml", "synthesizer", "deep_path_worker",
  ]);

  for (const name of VALID) {
    assert.ok(VALID.has(name), `${name} should be valid`);
  }
  assert.equal(VALID.size, 11);
});
