// SOC Dashboard tests — validates the rendered HTML contains required elements.
import test from "node:test";
import assert from "node:assert/strict";
import { renderDashboardPage } from "../services/gateway/dashboardPage.js";

const html = renderDashboardPage();

// ── Basic structure ────────────────────────────────────────────────────

test("renderDashboardPage returns valid HTML document", () => {
  assert.ok(html.includes("<!DOCTYPE html>"));
  assert.ok(html.includes("<html"));
  assert.ok(html.includes("</html>"));
  assert.ok(html.includes("ETDP SOC Dashboard"));
});

test("renderDashboardPage includes org selector", () => {
  assert.ok(html.includes('id="org-select"'));
  assert.ok(html.includes("/v1/orgs"));
});

// ── Navigation: all 8 nav items ────────────────────────────────────────

test("renderDashboardPage includes all 8 navigation items", () => {
  assert.ok(html.includes('data-view="overview"'));
  assert.ok(html.includes('data-view="threats"'));
  assert.ok(html.includes('data-view="users"'));
  assert.ok(html.includes('data-view="domains"'));
  assert.ok(html.includes('data-view="campaigns"'));
  assert.ok(html.includes('data-view="policies"'));
  assert.ok(html.includes('data-view="models"'));
  assert.ok(html.includes('data-view="health"'));
});

test("renderDashboardPage nav items have labels", () => {
  assert.ok(html.includes(">Overview</span>"));
  assert.ok(html.includes(">Threats</span>"));
  assert.ok(html.includes(">Users</span>"));
  assert.ok(html.includes(">Domains</span>"));
  assert.ok(html.includes(">Campaigns</span>"));
  assert.ok(html.includes(">Policies</span>"));
  assert.ok(html.includes(">Models</span>"));
  assert.ok(html.includes(">Health</span>"));
});

test("renderDashboardPage has nav rail with brand", () => {
  assert.ok(html.includes('class="nav-rail"'));
  assert.ok(html.includes('class="nav-brand"'));
  assert.ok(html.includes("ETDP Security"));
});

// ── View containers & routing ──────────────────────────────────────────

test("renderDashboardPage includes hash-based routing for all views", () => {
  assert.ok(html.includes("#overview"));
  assert.ok(html.includes("#threats"));
  assert.ok(html.includes("#incident/"));
  assert.ok(html.includes("#users"));
  assert.ok(html.includes("#domains"));
  assert.ok(html.includes("#campaigns"));
  assert.ok(html.includes("#policies"));
  assert.ok(html.includes("#models"));
  assert.ok(html.includes("hashchange"));
});

test("renderDashboardPage routing handles all view cases", () => {
  assert.ok(html.includes("renderOverview"));
  assert.ok(html.includes("renderThreats"));
  assert.ok(html.includes("renderIncident"));
  assert.ok(html.includes("renderUsers"));
  assert.ok(html.includes("renderDomains"));
  assert.ok(html.includes("renderCampaigns"));
  assert.ok(html.includes("renderPolicies"));
  assert.ok(html.includes("renderModels"));
});

test("renderDashboardPage has view title mapping", () => {
  assert.ok(html.includes("Executive Overview"));
  assert.ok(html.includes("Threat Detection Center"));
  assert.ok(html.includes("Incident Investigation"));
  assert.ok(html.includes("User Risk Dashboard"));
  assert.ok(html.includes("Domain Protection"));
  assert.ok(html.includes("Campaign Analysis"));
  assert.ok(html.includes("ML Models"));
});

// ── Overview view ──────────────────────────────────────────────────────

test("renderDashboardPage overview has 8 KPI cards", () => {
  assert.ok(html.includes("Total Analyzed"));
  assert.ok(html.includes("Blocked"));
  assert.ok(html.includes("Quarantined"));
  assert.ok(html.includes("Allowed"));
  assert.ok(html.includes("Phishing"));
  assert.ok(html.includes("Avg Confidence"));
  assert.ok(html.includes("FP Rate"));
  assert.ok(html.includes("/v1/stats"));
});

test("renderDashboardPage overview calls timeline and top-senders APIs", () => {
  assert.ok(html.includes("/v1/dashboard/timeline"));
  assert.ok(html.includes("/v1/dashboard/top-senders"));
});

test("renderDashboardPage overview has sparkline chart", () => {
  assert.ok(html.includes("drawSparkline"));
  assert.ok(html.includes("sparkline-container"));
});

test("renderDashboardPage overview has donut chart", () => {
  assert.ok(html.includes("drawDonut"));
  assert.ok(html.includes("<svg"));
  assert.ok(html.includes("<path"));
});

test("renderDashboardPage overview has horizontal bar chart", () => {
  assert.ok(html.includes("drawHBar"));
  assert.ok(html.includes("Label Distribution"));
});

test("renderDashboardPage overview has top senders table", () => {
  assert.ok(html.includes("Top Malicious Senders"));
});

// ── Threats view ───────────────────────────────────────────────────────

test("renderDashboardPage threats view has filter bar", () => {
  assert.ok(html.includes('id="tf-label"'));
  assert.ok(html.includes('id="tf-verdict"'));
  assert.ok(html.includes('id="tf-since"'));
  assert.ok(html.includes('id="tf-search"'));
  assert.ok(html.includes('id="tf-score"'));
});

test("renderDashboardPage threats view has bulk actions", () => {
  assert.ok(html.includes("bulk-bar"));
  assert.ok(html.includes("bulkAction"));
  assert.ok(html.includes("selectedRows"));
  assert.ok(html.includes("toggleRow"));
  assert.ok(html.includes("toggleAllRows"));
});

test("renderDashboardPage threats view has detail drawer", () => {
  assert.ok(html.includes('class="drawer"'));
  assert.ok(html.includes("drawer-overlay"));
  assert.ok(html.includes("openDrawer"));
  assert.ok(html.includes("closeDrawer"));
  assert.ok(html.includes("openThreatDrawer"));
});

test("renderDashboardPage drawer shows signal table with severity", () => {
  assert.ok(html.includes("sev-crit"));
  assert.ok(html.includes("sev-high"));
  assert.ok(html.includes("sev-med"));
  assert.ok(html.includes("sev-low"));
});

test("renderDashboardPage drawer shows auth chips", () => {
  assert.ok(html.includes("auth-chip"));
  assert.ok(html.includes("extractAuth"));
  assert.ok(html.includes("renderAuthChips"));
  assert.ok(html.includes("SPF"));
  assert.ok(html.includes("DKIM"));
  assert.ok(html.includes("DMARC"));
});

test("renderDashboardPage drawer has link to full investigation", () => {
  assert.ok(html.includes("Open Full Investigation"));
});

// ── Incident view ──────────────────────────────────────────────────────

test("renderDashboardPage incident view has attack chain SVG", () => {
  assert.ok(html.includes("drawAttackChain"));
  assert.ok(html.includes("attack-chain"));
  assert.ok(html.includes("arrowhead"));
});

test("renderDashboardPage incident view has threat narrative", () => {
  assert.ok(html.includes("Threat Narrative"));
});

test("renderDashboardPage incident view has feedback actions", () => {
  assert.ok(html.includes("Release"));
  assert.ok(html.includes("Confirm Block"));
  assert.ok(html.includes("Mark Ham"));
  assert.ok(html.includes("Mark Phishing"));
  assert.ok(html.includes("Mark Spam"));
  assert.ok(html.includes("/v1/feedback"));
  assert.ok(html.includes("soc_dashboard"));
});

test("renderDashboardPage incident view has pipeline timing", () => {
  assert.ok(html.includes("pipeline-bar"));
  assert.ok(html.includes("fast_path_ms"));
  assert.ok(html.includes("deep_path_ms"));
  assert.ok(html.includes("engines_invoked"));
});

test("renderDashboardPage incident view has notes form", () => {
  assert.ok(html.includes("feedback-notes"));
  assert.ok(html.includes("submitFeedbackWithNotes"));
});

test("renderDashboardPage incident view has related messages link", () => {
  assert.ok(html.includes("Related Messages"));
});

// ── IOC extraction ─────────────────────────────────────────────────────

test("renderDashboardPage includes IOC extraction logic", () => {
  assert.ok(html.includes("extractIOCs"));
  assert.ok(html.includes("https?"));
  assert.ok(html.includes("IOCs") || html.includes("Indicators of Compromise"));
});

test("renderDashboardPage IOCs have copy buttons", () => {
  assert.ok(html.includes("copyToClipboard"));
  assert.ok(html.includes("copy-btn"));
});

// ── Users view ─────────────────────────────────────────────────────────

test("renderDashboardPage users view fetches user and VIP data", () => {
  assert.ok(html.includes("/v1/dashboard/users"));
  assert.ok(html.includes("/v1/dashboard/vips"));
});

test("renderDashboardPage users view has VIP section", () => {
  assert.ok(html.includes("VIP Users"));
  assert.ok(html.includes("trust_score"));
  assert.ok(html.includes("user-card"));
});

test("renderDashboardPage users view has targeted recipients table", () => {
  assert.ok(html.includes("Top Targeted Recipients"));
});

// ── Domains view ───────────────────────────────────────────────────────

test("renderDashboardPage domains view fetches domain and URL data", () => {
  assert.ok(html.includes("/v1/dashboard/domains"));
  assert.ok(html.includes("/v1/dashboard/urls"));
});

test("renderDashboardPage domains view has domain reputation table", () => {
  assert.ok(html.includes("Domain Reputation"));
  assert.ok(html.includes("first_seen") || html.includes("First Seen"));
  assert.ok(html.includes("is_freemail") || html.includes("Freemail"));
});

test("renderDashboardPage domains view has URL intelligence", () => {
  assert.ok(html.includes("URL Intelligence"));
  assert.ok(html.includes("risk_score") || html.includes("Risk Score"));
});

// ── Campaigns view ─────────────────────────────────────────────────────

test("renderDashboardPage campaigns view clusters by sender domain", () => {
  assert.ok(html.includes("campaign-card"));
  assert.ok(html.includes("toggleCampaign"));
  assert.ok(html.includes("campaign-details"));
});

// ── Policies view ──────────────────────────────────────────────────────

test("renderDashboardPage policies view has threshold editor", () => {
  assert.ok(html.includes("threshold-editor"));
  assert.ok(html.includes('id="th-block"'));
  assert.ok(html.includes('id="th-quarantine"'));
  assert.ok(html.includes("saveThresholds"));
});

test("renderDashboardPage policies view has cold-start ramp display", () => {
  assert.ok(html.includes("Cold-Start Ramp"));
  assert.ok(html.includes("Stats DB"));
  assert.ok(html.includes("Graph DB"));
});

test("renderDashboardPage policies view has engine status", () => {
  assert.ok(html.includes("Engine Status"));
  assert.ok(html.includes("/admin/status"));
});

// ── Models view ────────────────────────────────────────────────────────

test("renderDashboardPage models view fetches model data", () => {
  assert.ok(html.includes("/models"));
  assert.ok(html.includes("/deployments"));
  assert.ok(html.includes("/training_jobs"));
});

test("renderDashboardPage models view has traffic split visualization", () => {
  assert.ok(html.includes("traffic-bar"));
  assert.ok(html.includes("Incumbent"));
  assert.ok(html.includes("Canary"));
});

test("renderDashboardPage models view has model registry table", () => {
  assert.ok(html.includes("Model Registry"));
  assert.ok(html.includes("val_accuracy"));
  assert.ok(html.includes("val_precision"));
  assert.ok(html.includes("val_recall"));
  assert.ok(html.includes("val_fp_rate"));
});

test("renderDashboardPage models view has training jobs table", () => {
  assert.ok(html.includes("Training Jobs"));
  assert.ok(html.includes("labels_used"));
});

// ── Theme toggle ───────────────────────────────────────────────────────

test("renderDashboardPage has dark/light theme toggle", () => {
  assert.ok(html.includes("toggleTheme"));
  assert.ok(html.includes("theme-btn"));
  assert.ok(html.includes('id="theme-toggle"'));
  assert.ok(html.includes("data-theme"));
  assert.ok(html.includes("etdp_theme"));
});

test("renderDashboardPage has dark theme CSS variables", () => {
  assert.ok(html.includes("--bg: #0a0e14"));
  assert.ok(html.includes("--surface: #131920"));
  assert.ok(html.includes("--border: #1e2a36"));
});

test("renderDashboardPage has light theme CSS variables", () => {
  assert.ok(html.includes("--bg: #f6f8fa"));
  assert.ok(html.includes("--surface: #ffffff"));
  assert.ok(html.includes("--border: #d0d7de"));
});

// ── Score coloring ─────────────────────────────────────────────────────

test("renderDashboardPage includes signal display with score coloring", () => {
  assert.ok(html.includes("scoreClass"));
  assert.ok(html.includes("score-high"));
  assert.ok(html.includes("score-med"));
  assert.ok(html.includes("score-low"));
});

// ── XSS safety ─────────────────────────────────────────────────────────

test("renderDashboardPage includes XSS-safe escaping", () => {
  assert.ok(html.includes("function esc("));
  assert.ok(html.includes("textContent"));
});

// ── State persistence ──────────────────────────────────────────────────

test("renderDashboardPage includes localStorage for org persistence", () => {
  assert.ok(html.includes("localStorage"));
  assert.ok(html.includes("etdp_soc_org"));
});

// ── Legacy route support ───────────────────────────────────────────────

test("renderDashboardPage supports legacy #verdict/ route", () => {
  assert.ok(html.includes("#verdict/"));
  assert.ok(html.includes("encodeURIComponent"));
  assert.ok(html.includes("decodeURIComponent"));
});

// ── Severity design system colors ──────────────────────────────────────

test("renderDashboardPage uses design system severity colors", () => {
  assert.ok(html.includes("#f85149")); // critical
  assert.ok(html.includes("#db6d28")); // high
  assert.ok(html.includes("#d29922")); // medium
  assert.ok(html.includes("#3fb950")); // low
  assert.ok(html.includes("#58a6ff")); // info
});
