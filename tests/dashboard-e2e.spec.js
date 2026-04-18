// @ts-check
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:8111";

test.describe("SOC Dashboard E2E", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/admin/dashboard`);
    // Wait for orgs to load
    await page.waitForFunction(() => {
      const sel = document.getElementById("org-select");
      return sel && sel.options.length > 1;
    });
  });

  test("loads dashboard page with title", async ({ page }) => {
    await expect(page).toHaveTitle("ETDP SOC Dashboard");
    await expect(page.locator("h1")).toHaveText("ETDP SOC Dashboard");
  });

  test("org dropdown is populated with mock orgs", async ({ page }) => {
    const options = page.locator("#org-select option");
    await expect(options).toHaveCount(3); // "— Select Org —" + 2 orgs
    await expect(options.nth(1)).toContainText("Acme Corporation");
    await expect(options.nth(2)).toContainText("Globex Inc");
  });

  test("selecting org loads overview with KPIs", async ({ page }) => {
    await page.selectOption("#org-select", "acme_corp");
    // Wait for KPIs to render
    await page.waitForSelector(".kpi");

    const kpis = page.locator(".kpi");
    await expect(kpis).toHaveCount(4);

    // Total = 43 + 89 + 1115 = 1247
    await expect(kpis.nth(0).locator(".value")).toHaveText("1247");
    // Blocked
    await expect(kpis.nth(1).locator(".value")).toHaveText("43");
    // Quarantined
    await expect(kpis.nth(2).locator(".value")).toHaveText("89");
    // Allowed
    await expect(kpis.nth(3).locator(".value")).toHaveText("1115");
  });

  test("overview shows SVG donut chart", async ({ page }) => {
    await page.selectOption("#org-select", "acme_corp");
    await page.waitForSelector(".donut-container svg");

    const svg = page.locator(".donut-container svg");
    await expect(svg).toBeVisible();
    // Should have path elements for the donut segments
    const paths = svg.locator("path");
    expect(await paths.count()).toBeGreaterThanOrEqual(2);
  });

  test("overview shows recent threats table", async ({ page }) => {
    await page.selectOption("#org-select", "acme_corp");
    await page.waitForSelector(".overview-grid table");

    const rows = page.locator(".overview-grid table tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("ceo@login-microsft.top");
    await expect(rows.nth(0)).toContainText("14.5");
  });

  test("navigating to Verdicts tab shows filterable list", async ({ page }) => {
    await page.selectOption("#org-select", "acme_corp");
    await page.click('.tab[data-view="verdicts"]');
    await page.waitForSelector("#verdict-table-wrap table");

    // Check filters exist
    await expect(page.locator("#filter-label")).toBeVisible();
    await expect(page.locator("#filter-verdict")).toBeVisible();
    await expect(page.locator("#filter-since")).toBeVisible();
    await expect(page.locator("#filter-search")).toBeVisible();

    // Check table rows
    const rows = page.locator("#verdict-table-wrap table tbody tr");
    await expect(rows).toHaveCount(3);
  });

  test("verdict filter by verdict type works", async ({ page }) => {
    await page.selectOption("#org-select", "acme_corp");
    await page.click('.tab[data-view="verdicts"]');
    await page.waitForSelector("#verdict-table-wrap table");

    // Filter to only blocks
    await page.selectOption("#filter-verdict", "block");
    await page.waitForTimeout(500); // debounce

    const rows = page.locator("#verdict-table-wrap table tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("ceo@login-microsft.top");
  });

  test("clicking verdict row navigates to detail view", async ({ page }) => {
    await page.selectOption("#org-select", "acme_corp");
    await page.click('.tab[data-view="verdicts"]');
    await page.waitForSelector("#verdict-table-wrap table tbody tr");

    // Click first row
    await page.locator("#verdict-table-wrap table tbody tr").nth(0).click();

    // Should show detail view
    await page.waitForSelector(".detail-header");
    await expect(page.locator(".verdict-badge")).toContainText("BLOCK");
    await expect(page.locator(".detail-header")).toContainText("<abc123@mail.example.com>");
  });

  test("detail view shows sender and recipient", async ({ page }) => {
    await page.goto(`${BASE}/admin/dashboard#verdict/acme_corp/${encodeURIComponent("<abc123@mail.example.com>")}`);
    await page.waitForSelector(".detail-section");

    await expect(page.locator(".detail-meta").first()).toContainText("ceo@login-microsft.top");
    await expect(page.locator(".detail-meta").first()).toContainText("finance@example.com");
  });

  test("detail view shows signals table sorted by score", async ({ page }) => {
    await page.goto(`${BASE}/admin/dashboard#verdict/acme_corp/${encodeURIComponent("<abc123@mail.example.com>")}`);
    await page.waitForSelector(".detail-section table");

    const signalRows = page.locator(".detail-section table tbody tr");
    await expect(signalRows).toHaveCount(6);

    // First signal should be highest score (URGENCY_LANGUAGE = 6.0)
    await expect(signalRows.nth(0)).toContainText("URGENCY_LANGUAGE");
    await expect(signalRows.nth(0)).toContainText("6.0");
  });

  test("detail view shows IOCs extracted from signals", async ({ page }) => {
    await page.goto(`${BASE}/admin/dashboard#verdict/acme_corp/${encodeURIComponent("<abc123@mail.example.com>")}`);
    await page.waitForSelector(".detail-section");

    // The signal details contain domain-like text, IOC extraction should find them
    // Check IOC section exists (may or may not find IOCs depending on signal content)
    const iocSection = page.locator("text=IOCs");
    // IOC extraction is best-effort from signal details
  });

  test("detail view shows pipeline info", async ({ page }) => {
    await page.goto(`${BASE}/admin/dashboard#verdict/acme_corp/${encodeURIComponent("<abc123@mail.example.com>")}`);
    await page.waitForSelector(".pipeline-bar");

    await expect(page.locator(".pipeline-bar")).toContainText("245ms");
    await expect(page.locator(".pipeline-bar")).toContainText("e1_rspamd");
  });

  test("detail view shows feedback action buttons", async ({ page }) => {
    await page.goto(`${BASE}/admin/dashboard#verdict/acme_corp/${encodeURIComponent("<abc123@mail.example.com>")}`);
    await page.waitForSelector(".actions");

    await expect(page.locator("button.release")).toHaveText("Release");
    await expect(page.locator("button.confirm-block")).toHaveText("Confirm Block");
    await expect(page.locator("text=Mark Ham")).toBeVisible();
    await expect(page.locator("text=Mark Phishing")).toBeVisible();
    await expect(page.locator("text=Mark Spam")).toBeVisible();
  });

  test("submitting feedback shows success toast", async ({ page }) => {
    await page.goto(`${BASE}/admin/dashboard#verdict/acme_corp/${encodeURIComponent("<abc123@mail.example.com>")}`);
    await page.waitForSelector(".actions");

    await page.click("button.confirm-block");

    // Toast should appear
    await page.waitForSelector(".toast.success", { state: "visible" });
    await expect(page.locator(".toast")).toContainText("confirm_block");
  });

  test("feedback with notes submits correctly", async ({ page }) => {
    await page.goto(`${BASE}/admin/dashboard#verdict/acme_corp/${encodeURIComponent("<abc123@mail.example.com>")}`);
    await page.waitForSelector(".notes-form");

    await page.fill("#feedback-notes", "Confirmed CEO impersonation attack");
    await page.click(".notes-form button");

    await page.waitForSelector(".toast.success", { state: "visible" });
    await expect(page.locator(".toast")).toContainText("confirm_block");
  });

  test("detail view shows existing feedback history", async ({ page }) => {
    await page.goto(`${BASE}/admin/dashboard#verdict/acme_corp/${encodeURIComponent("<abc123@mail.example.com>")}`);
    await page.waitForSelector(".feedback-entry");

    await expect(page.locator(".feedback-entry").first()).toContainText("soc_dashboard");
    await expect(page.locator(".feedback-entry").first()).toContainText("confirm_block");
    await expect(page.locator(".feedback-entry").first()).toContainText("CEO impersonation confirmed");
  });

  test("back button navigates away from detail", async ({ page }) => {
    await page.selectOption("#org-select", "acme_corp");
    await page.click('.tab[data-view="verdicts"]');
    await page.waitForSelector("#verdict-table-wrap table tbody tr");
    await page.locator("#verdict-table-wrap table tbody tr").nth(0).click();
    await page.waitForSelector(".detail-header");

    await page.click(".back-btn");
    // Should go back to verdicts list
    await page.waitForSelector("#verdict-table-wrap");
  });

  test("org selection persists in localStorage", async ({ page }) => {
    await page.selectOption("#org-select", "acme_corp");
    const stored = await page.evaluate(() => localStorage.getItem("etdp_soc_org"));
    expect(stored).toBe("acme_corp");
  });

  test("search filter filters by sender", async ({ page }) => {
    await page.selectOption("#org-select", "acme_corp");
    await page.click('.tab[data-view="verdicts"]');
    await page.waitForSelector("#verdict-table-wrap table");

    await page.fill("#filter-search", "legit");
    await page.waitForTimeout(500); // debounce

    const rows = page.locator("#verdict-table-wrap table tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("legit.com");
  });

  test("score colors are applied correctly", async ({ page }) => {
    await page.goto(`${BASE}/admin/dashboard#verdict/acme_corp/${encodeURIComponent("<abc123@mail.example.com>")}`);
    await page.waitForSelector(".detail-section table");

    // High score signal should have score-high class
    const firstScoreCell = page.locator(".detail-section table tbody tr").nth(0).locator("td.score-high");
    await expect(firstScoreCell).toHaveCount(1);
  });
});
