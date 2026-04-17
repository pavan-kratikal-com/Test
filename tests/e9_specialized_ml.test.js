import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../services/e9_specialized_ml/index.js";

function email(o = {}) {
  return { org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [], ...o };
}

test("E9: pure-ASCII domain produces no signal", () => {
  assert.equal(analyze(email({ sender: "alice@example.com" })).length, 0);
});

test("E9: mixed_script_domain fires for Cyrillic 'а' masquerading as Latin 'a'", () => {
  // 'а' (U+0430) + ASCII letters
  const s = analyze(email({ sender: "alice@exаmple.com" }));
  const m = s.find((x) => x.signal === "mixed_script_domain");
  assert.ok(m, "expected mixed_script_domain to fire");
  assert.equal(m.score, 3.0);
});

test("E9: all-Cyrillic domain does NOT trigger mixed_script (single script)", () => {
  // "пример.рф" is all Cyrillic
  const s = analyze(email({ sender: "alice@пример.рф" }));
  assert.equal(s.some((x) => x.signal === "mixed_script_domain"), false);
});

test("E9: no crash when sender has no @ sign", () => {
  assert.doesNotThrow(() => analyze(email({ sender: "bad-sender" })));
});
