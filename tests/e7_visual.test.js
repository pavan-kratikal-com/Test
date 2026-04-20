import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../services/e7_visual/index.js";

function email(o = {}) {
  return { org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [], ...o };
}

test("E7: credential_form_detected fires on password field (double quotes)", () => {
  const s = analyze(email({ body_html: '<form><input type="password" /></form>' }));
  assert.ok(s.some((x) => x.signal === "credential_form_detected"));
});

test("E7: credential_form_detected fires on password field (single quotes)", () => {
  const s = analyze(email({ body_html: "<input type='password' name='p'>" }));
  assert.ok(s.some((x) => x.signal === "credential_form_detected"));
});

test("E7: no signal for forms without password fields", () => {
  const s = analyze(email({ body_html: '<form><input type="text"></form>' }));
  assert.equal(s.length, 0);
});

test("E7: no signal when body_html is absent", () => {
  assert.equal(analyze(email()).length, 0);
});

// ── visual_brand_behavioral ─────────────────────────────────────────

test("E7: visual_brand_behavioral fires when brand referenced but sender domain differs", () => {
  const s = analyze(email({
    sender: "attacker@evil.com",
    body_html: "<div>Sign in to your Microsoft Office 365 account</div>",
  }));
  assert.ok(s.some((x) => x.signal === "visual_brand_behavioral"));
  assert.equal(s.find((x) => x.signal === "visual_brand_behavioral").detail.brand, "microsoft");
});

test("E7: visual_brand_behavioral does NOT fire when sender domain matches brand", () => {
  const s = analyze(email({
    sender: "noreply@microsoft.com",
    body_html: "<div>Sign in to your Microsoft Office 365 account</div>",
  }));
  assert.equal(s.some((x) => x.signal === "visual_brand_behavioral"), false);
});

test("E7: visual_brand_behavioral fires on subject-line brand reference too", () => {
  const s = analyze(email({
    sender: "phish@evil.com",
    subject: "PayPal: Your account has been limited",
    body_html: "<div>Click to verify</div>",
  }));
  assert.ok(s.some((x) => x.signal === "visual_brand_behavioral"));
  assert.equal(s.find((x) => x.signal === "visual_brand_behavioral").detail.brand, "paypal");
});

// ── visual_harvesting_ux ────────────────────────────────────────────

test("E7: visual_harvesting_ux fires when 2+ credential harvesting UX patterns match", () => {
  const s = analyze(email({
    body_html: `<div>
      Your session has expired. Please confirm your identity.
      <div class="countdown">Timer: 5:00</div>
    </div>`,
  }));
  assert.ok(s.some((x) => x.signal === "visual_harvesting_ux"));
});

test("E7: visual_harvesting_ux does NOT fire with only 1 pattern match", () => {
  const s = analyze(email({
    body_html: "<div>Your session has expired</div>",
  }));
  assert.equal(s.some((x) => x.signal === "visual_harvesting_ux"), false);
});

// ── visual_internal_tool_mimic ──────────────────────────────────────

test("E7: visual_internal_tool_mimic fires when external sender mimics SSO", () => {
  const s = analyze(email({
    sender: "admin@evil.com",
    body_html: "<div>Login to your company portal using SSO</div>",
    _org_internal_domains: ["acmecorp.com"],
  }));
  assert.ok(s.some((x) => x.signal === "visual_internal_tool_mimic"));
});

test("E7: visual_internal_tool_mimic does NOT fire when sender is from org domain", () => {
  const s = analyze(email({
    sender: "admin@acmecorp.com",
    body_html: "<div>Login to your company portal using SSO</div>",
    _org_internal_domains: ["acmecorp.com"],
  }));
  assert.equal(s.some((x) => x.signal === "visual_internal_tool_mimic"), false);
});

test("E7: visual_internal_tool_mimic does NOT fire when _org_internal_domains is empty", () => {
  const s = analyze(email({
    sender: "admin@evil.com",
    body_html: "<div>Login to your company portal using SSO</div>",
    _org_internal_domains: [],
  }));
  assert.equal(s.some((x) => x.signal === "visual_internal_tool_mimic"), false);
});
