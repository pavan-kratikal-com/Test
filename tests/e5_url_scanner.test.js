import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../services/e5_url_scanner/index.js";

function email(o = {}) {
  return { org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [], ...o };
}

test("E5: no URLs → no signals", () => {
  assert.equal(analyze(email({ body_text: "plain text" })).length, 0);
});

test("E5: urls_present fires with count when URLs are benign", () => {
  const s = analyze(email({ body_text: "visit https://example.com and https://example.org" }));
  const u = s.find((x) => x.signal === "urls_present");
  assert.ok(u);
  assert.equal(u.detail.count, 2);
});

test("E5: suspicious_tld fires for .zip/.top/.xyz/.click/.mov", () => {
  for (const tld of [".zip", ".top", ".xyz", ".click", ".mov"]) {
    const s = analyze(email({ body_text: `https://evil${tld}/phish` }));
    const hit = s.find((x) => x.signal === "suspicious_tld");
    assert.ok(hit, `expected suspicious_tld for ${tld}`);
    assert.equal(hit.score, 2.0);
  }
});

test("E5: does not flag a benign .com URL", () => {
  const s = analyze(email({ body_text: "https://example.com" }));
  assert.equal(s.some((x) => x.signal === "suspicious_tld"), false);
});
