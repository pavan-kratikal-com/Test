// @ts-check
const { test, expect } = require("@playwright/test");

const BASE = "http://localhost:8000";
const TS = Date.now();
const EMAIL = `sandeep+${TS}@gsourcedata.com`;
const PASSWORD = "Gsource@2026";
const NAME = "Sandeep Kumar";
const ORG_NAME = "GSource Data";
const ORG_SLUG = "gsource-data";
const DOMAIN = "gsourcedata.com";

test.describe.serial("Signup → Onboarding → Login E2E", () => {
  test("1. Full signup wizard flow", async ({ page }) => {
    // ── Step 0: Create Account ───────────────────────────
    await page.goto(`${BASE}/signup`);
    await expect(page.locator(".brand h1")).toHaveText("ETDP Security");
    await expect(page.locator(".card h2")).toHaveText("Create Account");

    // Fill account form
    await page.fill("#f-acct-name", NAME);
    await page.fill("#f-acct-email", EMAIL);
    await page.fill("#f-acct-password", PASSWORD);

    // Listen for register API response
    const registerPromise = page.waitForResponse(
      (r) => r.url().includes("/auth/register") && r.request().method() === "POST"
    );
    await page.click("text=Create Account");
    const registerRes = await registerPromise;
    expect(registerRes.status()).toBe(200);

    // Wait for step to advance to "Org Details"
    await expect(page.locator(".card h2")).toHaveText("Organization Details", {
      timeout: 10000,
    });

    // ── Step 1: Org Details ──────────────────────────────
    await page.fill("#f-name", ORG_NAME);
    await expect(page.locator("#slug-preview")).toContainText(ORG_SLUG);
    await page.selectOption("#f-industry", "tech");
    await page.selectOption("#f-tz", "Asia/Kolkata");

    await page.click("text=Next");
    await expect(page.locator(".card h2")).toHaveText("Add Domains", {
      timeout: 5000,
    });

    // ── Step 2: Add Domains ──────────────────────────────
    await page.fill("#f-domain", DOMAIN);
    await page.click("text=Add");
    await expect(page.locator(".domain-table")).toContainText(DOMAIN);

    // Click Next to go to Integration
    const nextBtn = page.locator("button.btn.primary", { hasText: "Next" });
    await nextBtn.click();
    await expect(page.locator(".card h2")).toHaveText("Choose Integration", {
      timeout: 5000,
    });

    // ── Step 3: Choose Integration ───────────────────────
    await expect(page.locator(".int-card.selected h3")).toHaveText("SMTP Relay");

    // Click Next — this calls POST /v1/orgs
    const orgPromise = page.waitForResponse(
      (r) => r.url().includes("/v1/orgs") && r.request().method() === "POST"
    );
    await page.locator("button.btn.primary", { hasText: "Next" }).click();
    const orgRes = await orgPromise;
    expect(orgRes.status()).toBe(200);

    await expect(page.locator(".card h2")).toHaveText("Setup Instructions", {
      timeout: 15000,
    });

    // ── Step 4: Setup Instructions ───────────────────────
    await expect(page.locator(".instructions")).toContainText("Google Admin Console");

    await page.click("text=Next — Verify");
    await expect(page.locator(".card h2")).toHaveText("Verify & Complete", {
      timeout: 5000,
    });

    // ── Step 5: Verify & Complete ────────────────────────
    await expect(page.locator("#verify-list")).toContainText(DOMAIN, {
      timeout: 10000,
    });

    // Click Complete Setup — should redirect to dashboard
    await page.click("text=Complete Setup");
    await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 10000 });

    // Verify dashboard loaded
    await expect(page.locator('button[title="Sign out"]')).toBeVisible();
  });

  test("2. Login with created account", async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await expect(page.locator(".card h2")).toHaveText("Sign In");

    await page.fill("#f-email", EMAIL);
    await page.fill("#f-password", PASSWORD);
    await page.click("text=Sign In");

    await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 10000 });
  });

  test("3. Login with wrong password shows error", async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.fill("#f-email", EMAIL);
    await page.fill("#f-password", "wrongpassword");
    await page.click("text=Sign In");

    await expect(page.locator("#error")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#error")).toContainText("invalid");
  });

  test("4. Dashboard requires auth — redirects to login", async ({ page }) => {
    await page.goto(`${BASE}/admin/dashboard`);
    await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
  });

  test("5. API returns 401 without auth", async ({ request }) => {
    // Fresh request context — no cookies
    const res = await request.fetch(`${BASE}/v1/orgs`, {
      headers: { Accept: "application/json" },
    });
    expect(res.status()).toBe(401);
  });

  test("6. Logout clears session", async ({ page }) => {
    // Login first
    await page.goto(`${BASE}/login`);
    await page.fill("#f-email", EMAIL);
    await page.fill("#f-password", PASSWORD);
    await page.click("text=Sign In");
    await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 10000 });

    // Click logout
    await page.click('button[title="Sign out"]');
    await expect(page).toHaveURL(/\/login/, { timeout: 5000 });

    // Try dashboard again — should redirect
    await page.goto(`${BASE}/admin/dashboard`);
    await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
  });

  test("7. Duplicate registration returns error", async ({ page }) => {
    await page.goto(`${BASE}/signup`);
    await page.fill("#f-acct-name", NAME);
    await page.fill("#f-acct-email", EMAIL);
    await page.fill("#f-acct-password", PASSWORD);

    const regPromise = page.waitForResponse(
      (r) => r.url().includes("/auth/register") && r.request().method() === "POST"
    );
    await page.click("text=Create Account");
    const regRes = await regPromise;
    expect(regRes.status()).toBe(409);

    // Should show toast error, not advance
    await expect(page.locator(".toast.error")).toBeVisible({ timeout: 3000 });
    await expect(page.locator(".toast.error")).toContainText("already registered");
  });

  test("8. Org scoping — user sees their orgs after login", async ({ page }) => {
    // Login via browser
    await page.goto(`${BASE}/login`);
    await page.fill("#f-email", EMAIL);
    await page.fill("#f-password", PASSWORD);
    await page.click("text=Sign In");
    await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 10000 });

    // Fetch orgs API from within the authenticated page context
    const orgs = await page.evaluate(async () => {
      const res = await fetch("/v1/orgs");
      return res.json();
    });
    expect(orgs.length).toBeGreaterThan(0);
    expect(orgs.some((o) => o.name === "GSource Data")).toBeTruthy();
  });
});
