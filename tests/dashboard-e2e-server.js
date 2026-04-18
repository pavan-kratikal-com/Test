// Minimal test server for Playwright E2E tests of the SOC dashboard.
// Serves the dashboard HTML and provides mock API endpoints.
import http from "node:http";
import { renderDashboardPage } from "../services/gateway/dashboardPage.js";

const MOCK_ORGS = [
  { org_id: "acme_corp", name: "Acme Corporation", industry: "tech" },
  { org_id: "globex", name: "Globex Inc", industry: "banking" },
];

const MOCK_STATS = {
  org_id: "acme_corp",
  breakdown: [
    { label: "phishing", verdict: "block", n: 43 },
    { label: "spam", verdict: "quarantine", n: 89 },
    { label: "ham", verdict: "allow", n: 1115 },
  ],
};

const MOCK_VERDICTS = [
  {
    id: 1, org_id: "acme_corp", message_id: "<abc123@mail.example.com>",
    sender: "ceo@login-microsft.top", recipient: "finance@example.com",
    verdict: "block", label: "phishing", confidence: 0.97, threat_score: 14.5,
    reason: "Aggregate score 14.5 ≥ block threshold 10.",
    fast_path_ms: 245, deep_path_ms: 0, created_at: new Date().toISOString(),
  },
  {
    id: 2, org_id: "acme_corp", message_id: "<def456@news.bad.com>",
    sender: "news@bad.com", recipient: "all@acme.com",
    verdict: "quarantine", label: "spam", confidence: 0.41, threat_score: 6.2,
    reason: "Aggregate score 6.2 ≥ quarantine threshold 5.",
    fast_path_ms: 180, deep_path_ms: 0, created_at: new Date(Date.now() - 300000).toISOString(),
  },
  {
    id: 3, org_id: "acme_corp", message_id: "<ghi789@legit.com>",
    sender: "hello@legit.com", recipient: "user@acme.com",
    verdict: "allow", label: "ham", confidence: 0.02, threat_score: 0.2,
    reason: "No significant threat signals.",
    fast_path_ms: 120, deep_path_ms: 0, created_at: new Date(Date.now() - 600000).toISOString(),
  },
];

const MOCK_DETAIL = {
  verdict: {
    ...MOCK_VERDICTS[0],
    signals: JSON.stringify([
      { engine: "e1_rspamd", signal: "DMARC_POLICY_REJECT", score: 3.0, detail: { spf: "fail", dkim: "none" } },
      { engine: "e2_slm", signal: "URGENCY_LANGUAGE", score: 6.0, detail: "Contains URGENT keyword" },
      { engine: "e9_specialized_ml", signal: "confusable_chars", score: 2.5, detail: "microsft→microsoft" },
      { engine: "e2_slm", signal: "CEO_IMPERSONATION", score: 2.0, detail: { from_name: "CEO" } },
      { engine: "e1_rspamd", signal: "SPF_FAIL", score: 0.5, detail: {} },
      { engine: "e4_graph_db", signal: "NEW_SENDER", score: 0.5, detail: { first_seen: "today" } },
    ]),
    pipeline: JSON.stringify({
      fast_path_ms: 245, deep_path_ms: 0,
      engines_invoked: ["e1_rspamd", "e2_slm", "e3_stats_db", "e4_graph_db"],
      async_deep_path: false,
    }),
  },
  feedback: [
    { action: "confirm_block", source: "soc_dashboard", notes: "CEO impersonation confirmed", created_at: new Date(Date.now() - 120000).toISOString() },
  ],
};

const feedbackLog = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // CORS for fetch
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Dashboard HTML
  if (url.pathname === "/admin/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(renderDashboardPage());
    return;
  }

  // API: list orgs
  if (url.pathname === "/v1/orgs" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(MOCK_ORGS));
    return;
  }

  // API: stats
  if (url.pathname === "/v1/stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(MOCK_STATS));
    return;
  }

  // API: verdict detail
  if (url.pathname.match(/^\/v1\/verdicts\/[^/]+\/.+/) && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const detail = { ...MOCK_DETAIL };
    detail.feedback = [...MOCK_DETAIL.feedback, ...feedbackLog];
    res.end(JSON.stringify(detail));
    return;
  }

  // API: verdicts list
  if (url.pathname === "/v1/verdicts" && req.method === "GET") {
    const verdict = url.searchParams.get("verdict");
    const label = url.searchParams.get("label");
    let filtered = MOCK_VERDICTS;
    if (verdict) filtered = filtered.filter(v => v.verdict === verdict);
    if (label) filtered = filtered.filter(v => v.label === label);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: filtered.length, verdicts: filtered }));
    return;
  }

  // API: feedback
  if (url.pathname === "/v1/feedback" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      const data = JSON.parse(body);
      feedbackLog.push({ ...data, created_at: new Date().toISOString() });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", id: feedbackLog.length }));
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const port = Number(process.env.TEST_PORT || 8111);
server.listen(port, () => console.log(`Mock server on :${port}`));
export { server, port };
