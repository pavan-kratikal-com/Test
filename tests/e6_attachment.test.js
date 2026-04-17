import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../services/e6_attachment/index.js";

function email(o = {}) {
  return { org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [], ...o };
}

test("E6: no attachments → no signals", () => {
  assert.equal(analyze(email()).length, 0);
});

test("E6: dangerous_extension fires for .exe/.scr/.js/.vbs/.bat/.jar/.lnk", () => {
  for (const ext of [".exe", ".scr", ".js", ".vbs", ".bat", ".jar", ".lnk"]) {
    const s = analyze(email({ attachments: [{ filename: `payload${ext}` }] }));
    const hit = s.find((x) => x.signal === "dangerous_extension");
    assert.ok(hit, `expected dangerous_extension for ${ext}`);
    assert.equal(hit.detail.filename, `payload${ext}`);
  }
});

test("E6: PDF/DOCX attachments do not fire dangerous_extension", () => {
  const s = analyze(email({ attachments: [
    { filename: "report.pdf" }, { filename: "notes.docx" },
  ] }));
  assert.equal(s.length, 0);
});

test("E6: extension check is case-insensitive", () => {
  const s = analyze(email({ attachments: [{ filename: "MALWARE.EXE" }] }));
  assert.ok(s.some((x) => x.signal === "dangerous_extension"));
});
