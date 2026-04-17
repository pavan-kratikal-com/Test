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
